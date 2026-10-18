use super::*;

pub const MUTINYNET_CHALLENGE: &str =
    "512102f7561d208dd9ae99bf497273e16f389bdbd6c4742ddb8e6b216e64fa2928ad8f51ae";
pub const MUTINYNET_BLOCK_ONE: &str =
    "000002855893a0a9b24eaffc5efc770558a326fee4fc10c9da22fc19cd2954f9";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Regtest,
    Mutinynet,
}

impl Profile {
    pub fn from_request(req: &Value) -> Result<Self> {
        match req.get("network").and_then(Value::as_str) {
            None if req.get("network").is_none() && req.get("signetChallenge").is_none() => {
                Ok(Self::Regtest)
            }
            Some("regtest") if req.get("signetChallenge").is_none() => Ok(Self::Regtest),
            Some("signetcustom") if req["signetChallenge"] == MUTINYNET_CHALLENGE => {
                Ok(Self::Mutinynet)
            }
            _ => Err(
                "only regtest or the pinned Mutinynet custom Signet profile is supported".into(),
            ),
        }
    }

    pub fn from_wallet(wallet: &Wallet) -> Result<Self> {
        match wallet.cooperative_bitcoin_network() {
            BitcoinNetwork::Regtest => Ok(Self::Regtest),
            BitcoinNetwork::SignetCustom => Ok(Self::Mutinynet),
            _ => Err("unsupported wallet network".into()),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Regtest => "regtest",
            Self::Mutinynet => "signetcustom",
        }
    }

    pub fn bitcoin_network(self) -> BitcoinNetwork {
        match self {
            Self::Regtest => BitcoinNetwork::Regtest,
            Self::Mutinynet => BitcoinNetwork::SignetCustom,
        }
    }

    pub fn binding(self) -> Value {
        match self {
            Self::Regtest => json!({"network":self.name()}),
            Self::Mutinynet => json!({"network":self.name(),"signetChallenge":MUTINYNET_CHALLENGE}),
        }
    }

    pub fn check_intent(self, intent: &Value) -> Result<()> {
        if intent["network"] != self.name()
            || intent.get("signetChallenge") != self.binding().get("signetChallenge")
        {
            return Err("approval network or Signet challenge changed".into());
        }
        Ok(())
    }

    pub fn indexer_url(self) -> Result<String> {
        match std::env::var("RGB_INDEXER_URL") {
            Ok(url) if !url.trim().is_empty() => Ok(url),
            _ if self == Self::Regtest => Ok("127.0.0.1:50001".into()),
            _ => Err("Mutinynet requires an explicit RGB_INDEXER_URL".into()),
        }
    }

    pub fn check_indexer(self, indexer: &str) -> Result<()> {
        if self == Self::Mutinynet {
            // Custom Signets share genesis; block 1 identifies the intended chain.
            rgb_lib::wallet::rust_only::cooperative_check_indexer(
                indexer,
                self.bitcoin_network(),
                1,
                MUTINYNET_BLOCK_ONE,
            )?;
        }
        Ok(())
    }

    pub fn check_state(self, root: &std::path::Path, init: bool) -> Result<()> {
        let marker = root.join("network.json");
        if marker.exists() {
            if serde_json::from_slice::<Value>(&fs::read(marker)?)? != self.binding() {
                return Err("wallet state belongs to a different network profile".into());
            }
        } else if root.join("keys.json").exists() && self != Self::Regtest {
            return Err("unmarked existing wallet state cannot be used for Mutinynet".into());
        } else if init {
            private_write(&marker, &serde_json::to_vec(&self.binding())?)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rgb_lib::bitcoin::Network;

    #[test]
    fn custom_signet_requires_exact_challenge_and_rejects_other_networks() {
        assert_eq!(Profile::from_request(&json!({})).unwrap(), Profile::Regtest);
        assert_eq!(
            Profile::from_request(&Profile::Mutinynet.binding()).unwrap(),
            Profile::Mutinynet
        );
        for req in [
            json!({"network":"mainnet"}),
            json!({"network":"signet"}),
            json!({"network":"signetcustom"}),
            json!({"network":"signetcustom","signetChallenge":"00"}),
            json!({"network":"regtest","signetChallenge":MUTINYNET_CHALLENGE}),
            json!({"network":null}),
        ] {
            assert!(Profile::from_request(&req).is_err());
        }
        assert!(
            Profile::Mutinynet
                .check_intent(&Profile::Regtest.binding())
                .is_err()
        );
        assert!(
            Profile::Regtest
                .check_intent(&Profile::Mutinynet.binding())
                .is_err()
        );
        assert!(
            Profile::Mutinynet
                .check_intent(&Profile::Mutinynet.binding())
                .is_ok()
        );
        assert_eq!(
            Network::from(Profile::Mutinynet.bitcoin_network()),
            Network::Signet
        );
    }

    #[test]
    fn state_network_binding_prevents_reusing_keys_across_networks() {
        let root = std::env::temp_dir().join(format!("palka-network-test-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let result = (|| -> Result<()> {
            fs::write(root.join("keys.json"), b"synthetic-test-fixture")?;
            assert!(Profile::Mutinynet.check_state(&root, false).is_err());
            assert!(Profile::Regtest.check_state(&root, false).is_ok());
            fs::remove_file(root.join("keys.json"))?;
            Profile::Mutinynet.check_state(&root, true)?;
            assert!(Profile::Mutinynet.check_state(&root, false).is_ok());
            assert!(Profile::Regtest.check_state(&root, false).is_err());
            Ok(())
        })();
        fs::remove_dir_all(root).unwrap();
        result.unwrap();
    }

    #[test]
    fn transaction_builder_accepts_signet_address_only_on_custom_signet() {
        let mut request = Profile::Mutinynet.binding();
        request["op"] = json!("build");
        request["inputs"] = json!([{
            "txid":"0000000000000000000000000000000000000000000000000000000000000001",
            "vout":0,"amountSats":"2000","scriptPubKey":"00140000000000000000000000000000000000000000"
        }]);
        request["outputs"] = json!([{
            "address":"tb1qmt3ue2senlg6ddgmr76hwsk0rdvdk4rgeaen7l","amountSats":"1000"
        }]);
        let built = cooperative::public_operation(&request).unwrap();
        assert_eq!(built["feeSats"], "1000");
        assert_eq!(built["signed"], false);
        request["network"] = json!("regtest");
        request.as_object_mut().unwrap().remove("signetChallenge");
        assert!(cooperative::public_operation(&request).is_err());
        request["network"] = json!("mainnet");
        assert!(cooperative::public_operation(&request).is_err());
    }
}
