//! A regtest-only conflicting spend of one vanilla input. Never consumes RGB.
use super::*;
use rgb_lib::bitcoin::{
    Amount, Sequence, Transaction, TxIn, TxOut, Witness,
    absolute::LockTime,
    consensus::encode::deserialize_hex,
    hashes::{Hash, sha256},
    psbt::Psbt,
    sighash::EcdsaSighashType,
    transaction::Version,
};
use std::str::FromStr;

fn original(root: &std::path::Path) -> Result<Psbt> {
    let path = root.join("cancellation-context.json");
    let psbt = if path.exists() {
        let context: Value = serde_json::from_slice(&fs::read(path)?)?;
        context["psbt"].clone()
    } else {
        let review: Value = serde_json::from_slice(&fs::read(root.join("review-package.json"))?)?;
        review["final"]["psbt"].clone()
    };
    Ok(Psbt::from_str(
        psbt.as_str().ok_or("missing original PSBT")?,
    )?)
}

pub fn preview(wallet: &mut Wallet, root: &std::path::Path) -> Result<Value> {
    if root.join("cancellation-approval.json").exists() {
        return Err("cancellation already authorized".into());
    }
    let swap = original(root)?;
    let fee = swap
        .fee()?
        .to_sat()
        .checked_add(1000)
        .ok_or("fee overflow")?;
    if fee > 101000 {
        return Err("cancellation fee exceeds regtest limit".into());
    }
    let on = online(wallet)?;
    wallet.cooperative_check_index()?;
    let owned = wallet.list_unspents(Some(on), false, false)?;
    let (index, utxo) = swap
        .unsigned_tx
        .input
        .iter()
        .enumerate()
        .find_map(|(index, input)| {
            owned
                .iter()
                .find(|u| {
                    u.utxo.outpoint.txid == input.previous_output.txid.to_string()
                        && u.utxo.outpoint.vout == input.previous_output.vout
                        && !u.utxo.colorable
                        && u.rgb_allocations.is_empty()
                        && u.utxo.btc_amount >= fee + 1000
                })
                .map(|u| (index, u))
        })
        .ok_or(
            "no unspent vanilla cancellation input; sync the swap or update an unsigned trade",
        )?;
    let address = wallet.get_address()?;
    let script = Address::from_str(&address)?
        .require_network(Network::Regtest)?
        .script_pubkey();
    let amount = utxo.utxo.btc_amount - fee;
    let point = swap.unsigned_tx.input[index].previous_output;
    let tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: point,
            script_sig: Default::default(),
            sequence: Sequence::ENABLE_RBF_NO_LOCKTIME,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(amount),
            script_pubkey: script,
        }],
    };
    let mut psbt = Psbt::from_unsigned_tx(tx)?;
    psbt.inputs[0].witness_utxo = swap.inputs[index].witness_utxo.clone();
    psbt.inputs[0].non_witness_utxo = swap.inputs[index].non_witness_utxo.clone();
    psbt.inputs[0].sighash_type = Some(EcdsaSighashType::All.into());
    Ok(
        json!({"psbt":psbt.to_string(), "cancellationTxid":psbt.unsigned_tx.compute_txid().to_string(),
        "input":point.to_string(), "address":address, "returnSats":amount.to_string(), "feeSats":fee.to_string()}),
    )
}

pub fn sign(
    wallet: &mut Wallet,
    root: &std::path::Path,
    profile: &str,
    req: &Value,
) -> Result<Value> {
    let bytes = fs::read(root.join("cancellation-intent.json"))?;
    let mut bound = b"rgb-local-approval-v1\0".to_vec();
    bound.extend_from_slice(&bytes);
    let digest = sha256::Hash::hash(&bound).to_string();
    let intent: Value = serde_json::from_slice(&bytes)?;
    if req["approved"] != true
        || req["approvalDigest"] != digest
        || intent["network"] != "regtest"
        || intent["profile"] != profile
        || intent["fingerprint"] != wallet.get_keys().master_fingerprint
    {
        return Err("explicit current cancellation approval required".into());
    }
    let marker = root.join("cancellation-signature-intent.txt");
    let signature = root.join("cancellation-signature.psbt");
    if marker.exists() {
        if fs::read_to_string(&marker)? != digest {
            return Err("cancellation intent changed".into());
        }
        if signature.exists() {
            return Ok(json!({"signedPsbt":fs::read_to_string(signature)?}));
        }
    }
    let swap = original(root)?;
    let psbt = Psbt::from_str(intent["psbt"].as_str().ok_or("PSBT")?)?;
    if swap.unsigned_tx.compute_txid().to_string() != intent["originalTxid"]
        || psbt.unsigned_tx.compute_txid().to_string() != intent["cancellationTxid"]
        || psbt.inputs.len() != 1
        || psbt.outputs.len() != 1
    {
        return Err("cancellation transaction changed".into());
    }
    let point = psbt.unsigned_tx.input[0].previous_output;
    let prev = psbt.inputs[0]
        .non_witness_utxo
        .as_ref()
        .ok_or("full prevout required")?;
    if !swap
        .unsigned_tx
        .input
        .iter()
        .any(|i| i.previous_output == point)
        || point.to_string() != intent["input"]
        || prev.compute_txid() != point.txid
        || prev.output.get(point.vout as usize) != psbt.inputs[0].witness_utxo.as_ref()
        || psbt.inputs[0].sighash_type != Some(EcdsaSighashType::All.into())
    {
        return Err("invalid cancellation input".into());
    }
    let fee = psbt.fee()?.to_sat();
    let output = &psbt.unsigned_tx.output[0];
    let address = Address::from_str(intent["address"].as_str().ok_or("address")?)?
        .require_network(Network::Regtest)?;
    if fee != cooperative::units(&intent["feeSats"])?
        || fee == 0
        || fee > 101000
        || output.value.to_sat() != cooperative::units(&intent["returnSats"])?
        || output.value.to_sat() < 1000
        || output.script_pubkey != address.script_pubkey()
    {
        return Err("cancellation amounts or recipient changed".into());
    }
    let on = online(wallet)?;
    wallet.cooperative_check_index()?;
    let owned = wallet.list_unspents(Some(on), false, false)?;
    if !owned.iter().any(|u| {
        u.utxo.outpoint.txid == point.txid.to_string()
            && u.utxo.outpoint.vout == point.vout
            && !u.utxo.colorable
            && u.rgb_allocations.is_empty()
            && u.utxo.btc_amount == prev.output[point.vout as usize].value.to_sat()
    }) {
        return Err(
            "cancellation input must be an unspent owned vanilla output without RGB".into(),
        );
    }
    let inspection = wallet.inspect_psbt(psbt.to_string())?;
    if !inspection.inputs[0].is_mine || !inspection.outputs[0].is_mine {
        return Err("cancellation must pay the same wallet".into());
    }
    private_write(&marker, digest.as_bytes())?;
    let signed = wallet.sign_psbt(psbt.to_string(), None)?;
    private_write(&signature, signed.as_bytes())?;
    Ok(json!({"signedPsbt":signed}))
}

pub fn sync(wallet: &mut Wallet, root: &std::path::Path, req: &Value) -> Result<Value> {
    let swap = original(root)?;
    let raw = req["rawTx"].as_str().ok_or("rawTx")?;
    let tx: Transaction = deserialize_hex(raw)?;
    let original_id = swap.unsigned_tx.compute_txid().to_string();
    if tx.compute_txid().to_string() == original_id
        || tx.input.len() != 1
        || !swap
            .unsigned_tx
            .input
            .iter()
            .any(|i| i.previous_output == tx.input[0].previous_output)
    {
        return Err("not a conflicting cancellation transaction".into());
    }
    let index = swap
        .unsigned_tx
        .input
        .iter()
        .position(|i| i.previous_output == tx.input[0].previous_output)
        .ok_or("input")?;
    if wallet.inspect_psbt(swap.to_string())?.inputs[index].is_mine {
        let intent: Value =
            serde_json::from_slice(&fs::read(root.join("cancellation-intent.json"))?)?;
        if intent["cancellationTxid"] != tx.compute_txid().to_string() {
            return Err("unexpected spend of a local input".into());
        }
    }
    // This SDK extension independently checks indexer confirmation before updating state.
    wallet.cooperative_record_confirmed_tx(raw.into())?;
    online(wallet)?;
    wallet.cooperative_check_index()?;
    Ok(
        json!({"cancelled":true,"originalTxid":original_id,"cancellationTxid":tx.compute_txid().to_string()}),
    )
}
