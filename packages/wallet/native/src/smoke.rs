// Ordinary SDK send/receive infrastructure check, explicitly not an atomic swap.
use super::*;
use rgb_lib::{
    Assignment,
    bitcoin::{
        hashes::{Hash, sha256},
        psbt::Psbt,
        sighash::EcdsaSighashType,
    },
    wallet::{Recipient, RgbWalletOpsOnline, WitnessData},
};
use std::{collections::HashMap, str::FromStr};

pub fn run(wallet: &mut Wallet, root: &std::path::Path, req: &Value) -> Result<Value> {
    let on = online(wallet)?;
    match req["op"].as_str().ok_or("op")? {
        "smoke-receive" => {
            let path = root.join("smoke-invoice.json");
            if path.exists() {
                return Ok(serde_json::from_slice(&fs::read(path)?)?);
            }
            let receive = wallet.witness_receive(
                Some(req["contractId"].as_str().ok_or("contractId")?.into()),
                Assignment::Fungible(1),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_secs()
                    + 86400,
                vec!["rpc://127.0.0.1:3000/json-rpc".into()],
                1,
            )?;
            let value = serde_json::to_value(receive)?;
            private_write(&path, &serde_json::to_vec(&value)?)?;
            Ok(value)
        }
        "smoke-prepare" => {
            let path = root.join("smoke-review.json");
            if path.exists() {
                return Ok(serde_json::from_slice(&fs::read(path)?)?);
            }
            let id = req["contractId"].as_str().ok_or("contractId")?;
            let recipient = req["recipientId"].as_str().ok_or("recipientId")?;
            let begin = wallet.send_begin(
                on,
                HashMap::from([(
                    id.into(),
                    vec![Recipient {
                        recipient_id: recipient.into(),
                        assignment: Assignment::Fungible(1),
                        witness_data: Some(WitnessData {
                            amount_sat: 1000,
                            blinding: Some(777),
                        }),
                        transport_endpoints: vec!["rpc://127.0.0.1:3000/json-rpc".into()],
                    }],
                )]),
                true,
                2,
                1,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_secs()
                    + 86400,
                false,
            )?;
            let psbt = Psbt::from_str(&begin.psbt)?;
            let inspection = wallet.inspect_rgb_transfer(
                begin.psbt.clone(),
                begin.details.fascia_path.clone(),
                begin.details.entropy,
            )?;
            let review = json!({"network":"regtest","kind":"ordinary-rgb-send-not-swap","contractId":id,"amount":"1","recipientId":recipient,
                "recipientBtcSats":"1000","txid":psbt.unsigned_tx.compute_txid().to_string(),"feeSats":psbt.fee()?.to_sat().to_string(),
                "psbt":begin.psbt,"inspection":inspection});
            let h = sha256::Hash::hash(serde_json::to_string(&review)?.as_bytes()).to_string();
            let mut value = review;
            value["approvalDigest"] = json!(h);
            private_write(&path, &serde_json::to_vec(&value)?)?;
            Ok(value)
        }
        "smoke-execute" => {
            if req["approved"] != true {
                return Err("explicit smoke approval required".into());
            }
            let mut review: Value =
                serde_json::from_slice(&fs::read(root.join("smoke-review.json"))?)?;
            let h = review
                .as_object_mut()
                .ok_or("review")?
                .remove("approvalDigest")
                .ok_or("digest")?;
            if req["approvalDigest"] != h
                || sha256::Hash::hash(serde_json::to_string(&review)?.as_bytes()).to_string() != h
            {
                return Err("stale smoke approval".into());
            }
            let started = root.join("smoke-signature-intent.txt");
            let sigpath = root.join("smoke-signed.psbt");
            let psbt = Psbt::from_str(review["psbt"].as_str().ok_or("psbt")?)?;
            if psbt.inputs.iter().any(|i| {
                i.sighash_type
                    .is_some_and(|s| s != EcdsaSighashType::All.into())
            }) {
                return Err("SIGHASH_ALL required".into());
            }
            if !started.exists() {
                private_write(&started, h.as_str().ok_or("digest")?.as_bytes())?;
            }
            if fs::read_to_string(started)? != h {
                return Err("signature pinned to another intent".into());
            }
            let signed = if sigpath.exists() {
                fs::read_to_string(sigpath)?
            } else {
                let signed = wallet.sign_psbt(psbt.to_string(), None)?;
                private_write(&sigpath, signed.as_bytes())?;
                signed
            };
            let operation = wallet.send_end(on, signed)?;
            Ok(serde_json::to_value(operation)?)
        }
        "smoke-refresh" => Ok(serde_json::to_value(wallet.refresh(
            on,
            None,
            vec![],
            false,
        )?)?),
        _ => Err("unknown smoke operation".into()),
    }
}
