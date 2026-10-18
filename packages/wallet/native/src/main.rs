use rgb_lib::{
    AssetSchema, BitcoinNetwork,
    bitcoin::{Address, Network},
    keys::{WitnessVersion, generate_keys},
    wallet::{DatabaseType, OnlineOptions, RgbWalletOpsOffline, SinglesigKeys, Wallet, WalletData},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
};

mod cancellation;
mod cooperative;
mod smoke;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn atomic_strings(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(atomic_strings),
        Value::Object(fields) => {
            for (key, v) in fields {
                if [
                    "settled",
                    "future",
                    "spendable",
                    "issued_supply",
                    "btc_amount",
                    "Fungible",
                    "InflationRight",
                    "amount_sat",
                    "fee_sat",
                    "total_input_sat",
                    "total_output_sat",
                ]
                .contains(&key.as_str())
                    && v.is_number()
                {
                    *v = Value::String(v.to_string());
                } else {
                    atomic_strings(v);
                }
            }
        }
        _ => (),
    }
}

fn private_write(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn open_wallet(root: &std::path::Path, init: bool) -> Result<Wallet> {
    if init {
        fs::create_dir_all(root)?;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    let path = root.join("keys.json");
    if init && !path.exists() {
        let keys = generate_keys(BitcoinNetwork::Regtest, WitnessVersion::SegWitV0);
        private_write(
            &path,
            &serde_json::to_vec(&SinglesigKeys::from_keys(&keys, None))?,
        )?;
    }
    let keys: SinglesigKeys = serde_json::from_slice(&fs::read(path)?)?;
    // The SDK waits up to an hour for this file after an interrupted process.
    // Do not remove it automatically: another SDK client may still own it.
    if root
        .join(&keys.master_fingerprint)
        .join("rgb_runtime.lock")
        .exists()
    {
        return Err("RGB runtime lock exists; stop wallet processes and verify the lock is stale before recovery".into());
    }
    Ok(Wallet::new(
        WalletData {
            data_dir: root.to_string_lossy().into(),
            bitcoin_network: BitcoinNetwork::Regtest,
            database_type: DatabaseType::Sqlite,
            max_allocations_per_utxo: 5,
            supported_schemas: vec![AssetSchema::Nia],
        },
        keys,
    )?)
}

fn online(wallet: &mut Wallet) -> Result<rgb_lib::wallet::Online> {
    Ok(wallet.go_online(OnlineOptions {
        indexer_url: std::env::var("RGB_INDEXER_URL").unwrap_or_else(|_| "127.0.0.1:50001".into()),
        skip_consistency_check: false,
        vanilla_sync_lookback: 20,
    })?)
}

fn state_snapshot(wallet: &mut Wallet, profile: &str) -> Result<Value> {
    // Reuse the current locked wallet snapshot; online callers synchronize before this read.
    let unspents = wallet.list_unspents(None, false, true)?;
    Ok(
        json!({"profile":profile,"network":"regtest","btc":wallet.get_btc_balance(None,true)?,
        "stockBalances":wallet.cooperative_stock_balances()?.iter().map(|(k,v)|(k.clone(),v.to_string())).collect::<std::collections::BTreeMap<_,_>>(),
        "assets":wallet.list_assets(vec![])?,"unspents":unspents}),
    )
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{}", json!({"ok":false,"error":err.to_string()}));
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut raw = String::new();
    io::stdin().take(1_048_577).read_to_string(&mut raw)?;
    if raw.len() > 1_048_576 {
        return Err("request too large".into());
    }
    let req: Value = serde_json::from_str(&raw)?;
    let op = req["op"].as_str().ok_or("missing op")?;
    if op == "health" {
        let indexer = std::env::var("RGB_INDEXER_URL").unwrap_or_else(|_| "127.0.0.1:50001".into());
        let proxy = std::env::var("RGB_PROXY_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:3000/json-rpc".into());
        rgb_lib::wallet::rust_only::check_indexer_url(&indexer, BitcoinNetwork::Regtest)?;
        rgb_lib::wallet::rust_only::check_proxy_url(&proxy)?;
        println!(
            "{}",
            json!({"network":"regtest","indexer":true,"rgbProxyProtocolCompatible":true})
        );
        return Ok(());
    }
    if op == "capabilities" {
        println!(
            "{}",
            json!({"mode":"real","network":"regtest","sdk":"rgb-lib 0.3.0-beta.7",
            "sdkCommit":"1eaf0024c591e41843eb80cc8834082292668871",
            "directAtomic":false,"ringAtomic":false,"sign":false,
            "cooperativePrepare":true,"validateConsignment":true,"experimentalSigner":"explicit CLI approval only",
            "localSdkExtension":true,"ownedInputColoring":true,"unilateralCancellation":true,
            "reason":"Low-level bridge is not a network signing API; use authenticated protocol-v1 HTTP sidecar for supported regtest settlement"})
        );
        return Ok(());
    }
    if op == "build" || op == "merge" {
        println!("{}", cooperative::public_operation(&req)?);
        return Ok(());
    }
    let root = PathBuf::from(req["stateDir"].as_str().ok_or("missing stateDir")?);
    if !root.is_absolute() {
        return Err("stateDir must be absolute and private".into());
    }
    let profile = req["profile"].as_str().ok_or("missing profile")?;
    if !["alice", "bob", "carol"].contains(&profile) {
        return Err("invalid profile".into());
    }
    let root = root.join(profile);
    if op == "init" {
        fs::create_dir_all(&root)?;
    }
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join(".instance.lock"))?;
    lock.try_lock()?;
    let mut wallet = open_wallet(&root, op == "init")?;
    let trade_root = if let Some(key) = req["contextKey"].as_str() {
        if key.len() != 64
            || !key
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("invalid context key".into());
        }
        root.join("trades").join(key)
    } else {
        root.clone()
    };
    let mut result = match op {
        "smoke-receive" | "smoke-prepare" | "smoke-execute" | "smoke-refresh" => {
            smoke::run(&mut wallet, &root, &req)?
        }
        "color" => cooperative::color(&mut wallet, &req)?,
        "sign" | "preflight-sign" => cooperative::sign(&mut wallet, &trade_root, profile, &req)?,
        "sync-confirmed" => cooperative::sync_confirmed(&mut wallet, &trade_root, &req)?,
        "cancel-preview" => cancellation::preview(&mut wallet, &trade_root)?,
        "cancel-sign" => cancellation::sign(&mut wallet, &trade_root, profile, &req)?,
        "cancel-sync" => cancellation::sync(&mut wallet, &trade_root, &req)?,
        "check-index" => {
            let _on = online(&mut wallet)?;
            wallet.cooperative_check_index()?;
            json!({"synchronized":true})
        }
        "catalog-export" | "catalog-import" => cooperative::catalog(&mut wallet, &root, &req)?,
        "addresses" => {
            json!({"btcAddress":wallet.get_address()?,"rgbAddress":wallet.cooperative_colored_address()?})
        }
        "history" => serde_json::to_value(
            wallet.list_transfers(rgb_lib::wallet::AssetFilter::AnyOrNone, None)?,
        )?,
        "identity" => {
            json!({"profile":profile,"network":"regtest","fingerprint":wallet.get_keys().master_fingerprint})
        }
        "init" => {
            let addresses = root.join("addresses.json");
            if addresses.exists() {
                serde_json::from_slice(&fs::read(addresses)?)?
            } else {
                let btc = wallet.get_address()?;
                let rgb = wallet.cooperative_colored_address()?;
                let value = json!({"profile":profile,"network":"regtest","btcAddress":btc,"rgbAddress":rgb});
                private_write(&addresses, &serde_json::to_vec(&value)?)?;
                value
            }
        }
        "new-colored-address" => json!({"address":wallet.cooperative_colored_address()?}),
        "upstream-inspect" => {
            let path = root.join("upstream-inspect-fascia.json");
            fs::write(&path, serde_json::to_vec(&req["fascia"])?)?;
            serde_json::to_value(wallet.inspect_rgb_transfer(
                req["psbt"].as_str().ok_or("psbt")?.into(),
                path.to_string_lossy().into(),
                777,
            )?)?
        }
        "export" => cooperative::export(&wallet, &root, &req)?,
        "validate" => cooperative::validate(&mut wallet, &root, &req)?,
        "state" | "offline-state" => {
            if op == "state" {
                online(&mut wallet)?;
                wallet.cooperative_check_index()?;
            }
            state_snapshot(&mut wallet, profile)?
        }
        "issue" => {
            let on = online(&mut wallet)?;
            wallet.list_unspents(Some(on), false, false)?;
            let ticker = req["ticker"].as_str().ok_or("missing ticker")?;
            let assigned_demo = ticker.len() == 7
                && ticker.starts_with('T')
                && ticker.as_bytes()[1..].iter().all(u8::is_ascii_digit)
                && ticker != "T000000";
            if !["X", "DUSD", "KEEP"].contains(&ticker) && !assigned_demo {
                return Err("demo assets only".into());
            }
            let amount = req["amount"]
                .as_str()
                .ok_or("amount must be atomic-unit string")?;
            if amount.is_empty()
                || !amount.bytes().all(|c| c.is_ascii_digit())
                || amount.starts_with('0')
            {
                return Err("invalid amount".into());
            }
            let amount: u64 = amount.parse()?;
            let receipt = root.join(format!("issued-{ticker}.json"));
            if receipt.exists() {
                let saved: Value = serde_json::from_slice(&fs::read(receipt)?)?;
                if saved["ticker"] != ticker || saved["issued_supply"].as_u64() != Some(amount) {
                    return Err("saved issuance does not match requested ticker and amount".into());
                }
                saved
            } else {
                // A lost response after SDK issuance must never create a second contract.
                let pending = root.join(format!("issuing-{ticker}.json"));
                if pending.exists() {
                    return Err(
                        "uncertain issuance; reconcile the local wallet before retrying".into(),
                    );
                }
                private_write(
                    &pending,
                    &serde_json::to_vec(&json!({"ticker":ticker,"amount":amount.to_string()}))?,
                )?;
                let asset = wallet.issue_asset_nia(
                    ticker.into(),
                    format!("Regtest {ticker}"),
                    0,
                    vec![amount],
                )?;
                let value = serde_json::to_value(asset)?;
                private_write(&receipt, &serde_json::to_vec(&value)?)?;
                fs::remove_file(pending)?;
                value
            }
        }
        _ => return Err("unsupported operation".into()),
    };
    atomic_strings(&mut result);
    println!("{}", result);
    Ok(())
}
