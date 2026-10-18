use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use psrgbt::{RgbOutExt, RgbPsbtExt};
use rgb_lib::{
    Assignment, CloseMethod, ContractId, Fascia, FileContent, RgbTransfer,
    bitcoin::{
        Amount, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness,
        absolute::LockTime,
        consensus::encode::deserialize_hex,
        hashes::{Hash, sha256},
        psbt::Psbt,
        sighash::EcdsaSighashType,
        transaction::Version,
    },
    wallet::rust_only::{AssetColoringInfo, ColoringInfo},
};
use std::{
    collections::{BTreeMap, HashMap},
    str::FromStr,
};

pub fn catalog(wallet: &mut Wallet, root: &std::path::Path, req: &Value) -> Result<Value> {
    let path = root.join("catalog.rgbc");
    if req["op"] == "catalog-export" {
        wallet
            .cooperative_export_contract(req["contractId"].as_str().ok_or("contractId")?.parse()?)?
            .save_file(&path)?;
        Ok(json!({"contract":STANDARD.encode(fs::read(path)?)}))
    } else {
        let _on = online(wallet)?;
        fs::write(
            &path,
            STANDARD.decode(req["contract"].as_str().ok_or("contract")?)?,
        )?;
        Ok(json!({"contractId":wallet.cooperative_import_contract(RgbTransfer::load_file(path)?)?}))
    }
}

pub fn units(v: &Value) -> Result<u64> {
    let s = v.as_str().ok_or("amount must be decimal string")?;
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) || (s.len() > 1 && s.starts_with('0'))
    {
        return Err("invalid atomic units".into());
    }
    Ok(s.parse()?)
}

fn parse_psbt(v: &Value) -> Result<Psbt> {
    let psbt = Psbt::from_str(v.as_str().ok_or("missing PSBT")?)?;
    if psbt.inputs.iter().any(|i| {
        !i.partial_sigs.is_empty()
            || i.final_script_sig.is_some()
            || i.final_script_witness.is_some()
            || i.tap_key_sig.is_some()
            || !i.tap_script_sigs.is_empty()
    }) {
        return Err("spike accepts unsigned PSBTs only".into());
    }
    Ok(psbt)
}

pub fn public_operation(req: &Value) -> Result<Value> {
    let mut final_fascia = None;
    let mut psbt = if req["op"] == "build" {
        let inputs = req["inputs"].as_array().ok_or("inputs")?;
        let mut seen = std::collections::HashSet::new();
        let mut tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![],
            output: vec![],
        };
        let mut prevouts = vec![];
        for i in inputs {
            let outpoint = OutPoint {
                txid: i["txid"].as_str().ok_or("txid")?.parse()?,
                vout: i["vout"].as_u64().ok_or("vout")?.try_into()?,
            };
            if !seen.insert(outpoint) {
                return Err("duplicate input".into());
            }
            tx.input.push(TxIn {
                previous_output: outpoint,
                script_sig: ScriptBuf::new(),
                sequence: Sequence::MAX,
                witness: Witness::new(),
            });
            prevouts.push(TxOut {
                value: Amount::from_sat(units(&i["amountSats"])?),
                script_pubkey: ScriptBuf::from_hex(i["scriptPubKey"].as_str().ok_or("script")?)?,
            });
        }
        for o in req["outputs"].as_array().ok_or("outputs")? {
            let address = Address::from_str(o["address"].as_str().ok_or("address")?)?
                .require_network(Network::Regtest)?;
            // Avoid color_psbt's implicit Taproot vout shifting in this fixed SegWit-v0 spike.
            if address.script_pubkey().is_p2tr() {
                return Err("spike requires SegWit v0 outputs".into());
            }
            tx.output.push(TxOut {
                value: Amount::from_sat(units(&o["amountSats"])?),
                script_pubkey: address.script_pubkey(),
            });
        }
        tx.output.push(TxOut {
            value: Amount::ZERO,
            script_pubkey: ScriptBuf::new_op_return([]),
        });
        let mut psbt = Psbt::from_unsigned_tx(tx)?;
        for (i, prev) in psbt.inputs.iter_mut().zip(prevouts) {
            i.witness_utxo = Some(prev);
            i.sighash_type = Some(EcdsaSighashType::All.into());
        }
        for (index, input) in inputs.iter().enumerate() {
            if let Some(raw) = input["rawTx"].as_str() {
                let tx: Transaction = deserialize_hex(raw)?;
                let point = psbt.unsigned_tx.input[index].previous_output;
                if tx.compute_txid() != point.txid
                    || tx.output.get(point.vout as usize)
                        != psbt.inputs[index].witness_utxo.as_ref()
                {
                    return Err("previous transaction mismatch".into());
                }
                psbt.inputs[index].non_witness_utxo = Some(tx);
            }
        }
        psbt.fee()?;
        psbt
    } else {
        let mut base = parse_psbt(&req["basePsbt"])?;
        for contribution in req["contributions"].as_array().ok_or("contributions")? {
            let partial = parse_psbt(contribution)?;
            let mut unsigned = partial.unsigned_tx.clone();
            for o in &mut unsigned.output {
                if o.script_pubkey.is_op_return() {
                    o.script_pubkey = ScriptBuf::new_op_return([]);
                }
            }
            if unsigned != base.unsigned_tx {
                return Err("contribution changed transaction skeleton".into());
            }
            for (_, bundle) in partial.rgb_bundles()? {
                for known in bundle.known_transitions {
                    base.push_rgb_transition(known.transition)?;
                }
            }
        }
        let host = base.outputs.last_mut().ok_or("host")?;
        host.set_opret_host();
        host.set_mpc_entropy(777)?;
        base.set_rgb_close_method(CloseMethod::OpretFirst);
        base.set_as_unmodifiable();
        final_fascia = Some(base.rgb_commit()?);
        base
    };
    psbt.set_as_unmodifiable();
    let mut fascia = serde_json::to_value(final_fascia)?;
    if let Some(bundles) = fascia.get_mut("bundles").and_then(Value::as_object_mut) {
        for bundle in bundles.values_mut() {
            if let Some(transitions) = bundle
                .get_mut("knownTransitions")
                .and_then(Value::as_array_mut)
            {
                // The SDK serializes this set in random order; package equality must be stable.
                transitions.sort_by_cached_key(ToString::to_string);
            }
        }
    }
    Ok(
        json!({"psbt":psbt.to_string(),"candidateTxid":psbt.unsigned_tx.compute_txid().to_string(),
        "unsignedTxHex":rgb_lib::bitcoin::consensus::encode::serialize_hex(&psbt.unsigned_tx),
        "commitmentScripts":psbt.unsigned_tx.output.iter().filter(|o|o.script_pubkey.is_op_return()).map(|o|o.script_pubkey.to_hex_string()).collect::<Vec<_>>(),
        "signed":false,"broadcast":false,"feeSats":psbt.fee()?.to_sat().to_string(),
        "fascia":fascia,
        "contracts":psbt.rgb_contract_ids()?.iter().map(ToString::to_string).collect::<Vec<_>>() }),
    )
}

pub fn sign(
    wallet: &mut Wallet,
    root: &std::path::Path,
    profile: &str,
    req: &Value,
) -> Result<Value> {
    let preflight = req["op"] == "preflight-sign";
    if !preflight && req["approved"] != true {
        return Err("explicit user approval required".into());
    }
    let raw = fs::read(root.join("approval-intent.json"))?;
    let mut bytes = b"rgb-local-approval-v1\0".to_vec();
    bytes.extend_from_slice(&raw);
    let digest = sha256::Hash::hash(&bytes).to_string();
    if req["approvalDigest"].as_str() != Some(&digest) {
        return Err("stale approval".into());
    }
    let intent: Value = serde_json::from_slice(&raw)?;
    if intent["network"] != "regtest"
        || intent["profile"] != profile
        || intent["fingerprint"] != wallet.get_keys().master_fingerprint
    {
        return Err("wrong local wallet".into());
    }
    let sig_path = root.join("released-signature.psbt");
    let started = root.join("signature-intent.txt");
    if started.exists() {
        if fs::read_to_string(&started)? != digest {
            return Err("another signature may exist; inputs remain reserved".into());
        }
        if preflight {
            return Err("signature already started; reconcile instead".into());
        }
        if sig_path.exists() {
            return Ok(
                json!({"signedPsbt":fs::read_to_string(sig_path)?,"approvalDigest":digest,"replayed":true}),
            );
        }
    }
    let package: Value = serde_json::from_slice(&fs::read(root.join("review-package.json"))?)?;
    let psbt = parse_psbt(&package["final"]["psbt"])?;
    // The approved fee is a canonical decimal string, not a JSON number.
    let fee_sats = psbt.fee()?.to_sat().to_string();
    if psbt.unsigned_tx.compute_txid().to_string() != intent["candidateTxid"]
        || fee_sats != intent["feeSats"]
    {
        return Err("transaction changed after approval".into());
    }
    for (idx, input) in psbt.inputs.iter().enumerate() {
        if input.sighash_type != Some(EcdsaSighashType::All.into()) {
            return Err("SIGHASH_ALL required".into());
        }
        let prev = input
            .non_witness_utxo
            .as_ref()
            .ok_or("full previous transaction required")?;
        let point = psbt.unsigned_tx.input[idx].previous_output;
        if prev.compute_txid() != point.txid
            || prev.output.get(point.vout as usize) != input.witness_utxo.as_ref()
        {
            return Err("unverified prevout".into());
        }
    }
    let on = online(wallet)?;
    let owned = wallet.list_unspents(Some(on), false, false)?;
    let inspection = wallet.inspect_psbt(psbt.to_string())?;
    let mut btc_in = 0i128;
    for input in inspection.inputs.iter().filter(|i| i.is_mine) {
        if !owned
            .iter()
            .any(|u| u.utxo.outpoint == input.outpoint && u.utxo.btc_amount == input.amount_sat)
        {
            return Err("stale owned input".into());
        }
        btc_in += input.amount_sat as i128;
    }
    if btc_in == 0 {
        return Err("no owned inputs".into());
    }
    let btc_out: i128 = inspection
        .outputs
        .iter()
        .filter(|o| o.is_mine)
        .map(|o| o.amount_sat as i128)
        .sum();
    if (btc_out - btc_in).to_string() != intent["expectedBtcDeltaSats"] {
        return Err("BTC delta changed".into());
    }
    for receive in intent["receives"].as_array().ok_or("receives")? {
        let mut check = receive.clone();
        check["psbt"] = json!(psbt.to_string());
        validate_online(wallet, root, &check, on)?;
    }
    if intent["assignments"]
        .as_object()
        .is_some_and(|a| !a.is_empty())
    {
        let mut base = psbt.clone();
        base.proprietary.clear();
        for (o, meta) in base
            .unsigned_tx
            .output
            .iter_mut()
            .zip(base.outputs.iter_mut())
        {
            if o.script_pubkey.is_op_return() {
                o.script_pubkey = ScriptBuf::new_op_return([]);
                meta.proprietary.clear();
            }
        }
        let own = color_online(
            wallet,
            &json!({"psbt":base.to_string(),"assignments":intent["assignments"]}),
            on,
        )?;
        let own = parse_psbt(&own["psbt"])?;
        let combined = psbt.rgb_bundles()?;
        for (id, bundle) in own.rgb_bundles()? {
            let actual = combined.get(&id).ok_or("outgoing RGB contract missing")?;
            // Other senders may contribute this contract, but cannot replace our consumers or transitions.
            if bundle
                .input_map
                .iter()
                .any(|(input, opid)| actual.input_map.get(input) != Some(opid))
                || bundle
                    .known_transitions
                    .iter()
                    .any(|expected| !actual.known_transitions.contains(expected))
            {
                return Err("outgoing RGB transition changed".into());
            }
        }
    } else if owned.iter().any(|u| {
        !u.rgb_allocations.is_empty()
            && psbt.unsigned_tx.input.iter().any(|i| {
                i.previous_output.txid.to_string() == u.utxo.outpoint.txid
                    && i.previous_output.vout == u.utxo.outpoint.vout
            })
    }) {
        return Err("unaccounted RGB allocations".into());
    }
    if preflight {
        wallet.cooperative_check_index()?;
        let state = state_snapshot(wallet, profile)?;
        return Ok(
            json!({"readyForApproval":true,"signed":false,"approvalDigest":digest,"btcDeltaSats":(btc_out-btc_in).to_string(),"sighash":"ALL","state":state}),
        );
    }
    if !started.exists() {
        private_write(&started, digest.as_bytes())?;
    }
    // Keep signatures separate from the immutable approval identity. Default trust checks stay on.
    let options = rgb_lib::bdk_wallet::SignOptions {
        try_finalize: false,
        ..Default::default()
    };
    let signed = wallet.sign_psbt(psbt.to_string(), Some(options))?;
    let signed_psbt = Psbt::from_str(&signed)?;
    if signed_psbt.inputs.iter().all(|i| i.partial_sigs.is_empty()) {
        return Err("wallet produced no signature".into());
    }
    private_write(&sig_path, signed.as_bytes())?;
    Ok(json!({"signedPsbt":signed,"approvalDigest":digest,"replayed":false}))
}

pub fn sync_confirmed(wallet: &mut Wallet, root: &std::path::Path, req: &Value) -> Result<Value> {
    let intent: Value = serde_json::from_slice(&fs::read(root.join("approval-intent.json"))?)?;
    if !root.join("signature-intent.txt").exists() {
        return Err("no signed local intent".into());
    }
    let raw = req["rawTx"].as_str().ok_or("rawTx")?;
    let tx: Transaction = deserialize_hex(raw)?;
    if tx.compute_txid().to_string() != intent["candidateTxid"] {
        return Err("unexpected transaction".into());
    }
    wallet.cooperative_record_confirmed_tx(raw.into())?;
    let on = online(wallet)?;
    let package: Value = serde_json::from_slice(&fs::read(root.join("review-package.json"))?)?;
    for receive in intent["receives"].as_array().ok_or("receives")? {
        let path = root.join("confirmed.rgbc");
        fs::write(
            &path,
            STANDARD.decode(receive["consignment"].as_str().ok_or("consignment")?)?,
        )?;
        let id = ContractId::from_str(receive["contractId"].as_str().ok_or("contractId")?)?;
        let was_known = wallet.is_asset_known(id)?;
        let (consignment, _, _) = wallet.accept_transfer_consignment(
            on,
            path,
            tx.compute_txid().to_string(),
            receive["vout"].as_u64().ok_or("vout")?.try_into()?,
            777,
        )?;
        wallet.cooperative_store_receipt(
            &tx.compute_txid().to_string(),
            &id.to_string(),
            true,
            consignment.clone(),
        )?;
        if !was_known {
            wallet.save_new_asset(on, consignment, tx.compute_txid().to_string())?;
        }
    }
    wallet
        .cooperative_consume_known(serde_json::from_value(package["final"]["fascia"].clone())?)?;
    wallet.update_witnesses(on, 0, vec![tx.compute_txid().to_string().parse()?])?;
    for (id, outputs) in intent["assignments"].as_object().ok_or("assignments")? {
        let vouts = outputs
            .as_object()
            .ok_or("assignment outputs")?
            .keys()
            .map(|s| s.parse())
            .collect::<std::result::Result<Vec<u32>, _>>()?;
        let proof = wallet.cooperative_consignment(
            &serde_json::from_value(package["final"]["fascia"].clone())?,
            id.parse()?,
            vouts,
        )?;
        wallet.cooperative_store_receipt(&tx.compute_txid().to_string(), id, false, proof)?;
    }
    wallet.cooperative_index_confirmed(raw.into())?;
    let balances = wallet
        .cooperative_stock_balances()?
        .iter()
        .map(|(k, v)| (k.clone(), v.to_string()))
        .collect::<BTreeMap<_, _>>();
    Ok(
        json!({"chainConfirmed":true,"rgbAccepted":true,"txid":tx.compute_txid().to_string(),"stockBalances":balances,
        "btc":wallet.get_btc_balance(Some(on),false)?,"sdkAllocationIndexSynchronized":true}),
    )
}

pub fn export(wallet: &Wallet, root: &std::path::Path, req: &Value) -> Result<Value> {
    let fascia: Fascia = serde_json::from_value(req["fascia"].clone())?;
    let id = ContractId::from_str(req["contractId"].as_str().ok_or("contractId")?)?;
    let vouts: Vec<u32> = serde_json::from_value(req["vouts"].clone())?;
    let transfer = wallet.cooperative_consignment(&fascia, id, vouts)?;
    let path = root.join("export.rgbc");
    transfer.save_file(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let content = STANDARD.encode(fs::read(path)?);
    Ok(
        json!({"consignment":content,"contractId":id.to_string(),"candidateTxid":fascia.witness_id().to_string()}),
    )
}

pub fn validate(wallet: &mut Wallet, root: &std::path::Path, req: &Value) -> Result<Value> {
    let on = online(wallet)?;
    validate_online(wallet, root, req, on)
}

fn validate_online(
    wallet: &mut Wallet,
    root: &std::path::Path,
    req: &Value,
    on: rgb_lib::wallet::Online,
) -> Result<Value> {
    let psbt = parse_psbt(&req["psbt"])?;
    let id = ContractId::from_str(req["contractId"].as_str().ok_or("contractId")?)?;
    let vout: u32 = req["vout"].as_u64().ok_or("vout")?.try_into()?;
    let expected = units(&req["amount"])?;
    let address = Address::from_str(req["address"].as_str().ok_or("address")?)?
        .require_network(Network::Regtest)?;
    let output = psbt
        .unsigned_tx
        .output
        .get(vout as usize)
        .ok_or("output not found")?;
    if output.script_pubkey != address.script_pubkey() {
        return Err("recipient script mismatch".into());
    }
    if !wallet.inspect_psbt(psbt.to_string())?.outputs[vout as usize].is_mine {
        return Err("recipient output not owned by validating wallet".into());
    }
    let path = root.join("validate.rgbc");
    // This is public consignment data, never wallet keys. The profile lock serializes it.
    let bytes = STANDARD.decode(req["consignment"].as_str().ok_or("consignment")?)?;
    fs::write(&path, bytes)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let consignment = RgbTransfer::load_file(&path)?;
    let assignments = wallet.cooperative_validate(
        on,
        consignment,
        psbt.unsigned_tx.compute_txid().to_string(),
        id,
        vout,
    )?;
    let actual = assignments
        .into_iter()
        .try_fold(0u64, |sum, a| -> Result<u64> {
            match a {
                Assignment::Fungible(n) => Ok(sum.checked_add(n).ok_or("overflow")?),
                _ => Err("non-NIA assignment".into()),
            }
        })?;
    if actual != expected {
        return Err("RGB amount mismatch".into());
    }
    Ok(
        json!({"valid":true,"network":"regtest","contractId":id.to_string(),"amount":actual.to_string(),"signed":false,"chainConfirmed":false}),
    )
}

pub fn color(wallet: &mut Wallet, req: &Value) -> Result<Value> {
    let on = online(wallet)?;
    color_online(wallet, req, on)
}

fn color_online(wallet: &mut Wallet, req: &Value, on: rgb_lib::wallet::Online) -> Result<Value> {
    let mut psbt = parse_psbt(&req["psbt"])?;
    if psbt
        .unsigned_tx
        .output
        .iter()
        .filter(|o| o.script_pubkey.is_op_return())
        .count()
        != 1
        || psbt
            .unsigned_tx
            .output
            .iter()
            .any(|o| o.script_pubkey.is_p2tr())
    {
        return Err("expected fixed SegWit v0 skeleton with one OP_RETURN".into());
    }
    let utxos = wallet.list_unspents(Some(on), false, false)?;
    let mut owned = BTreeMap::<String, u64>::new();
    let mut owned_points = std::collections::HashSet::new();
    for u in utxos {
        if !psbt.unsigned_tx.input.iter().any(|i| {
            i.previous_output.txid.to_string() == u.utxo.outpoint.txid
                && i.previous_output.vout == u.utxo.outpoint.vout
        }) {
            continue;
        }
        owned_points.insert(OutPoint {
            txid: u.utxo.outpoint.txid.parse()?,
            vout: u.utxo.outpoint.vout,
        });
        if u.pending_blinded != 0 {
            return Err("pending blind allocation on selected input".into());
        }
        for a in u.rgb_allocations {
            if !a.settled {
                return Err("unsettled allocation".into());
            }
            let id = a.asset_id.ok_or("unknown allocation contract")?;
            if let Assignment::Fungible(n) = a.assignment {
                let current = owned.entry(id).or_default();
                *current = current.checked_add(n).ok_or("amount overflow")?;
            } else {
                return Err("non-NIA allocation unsupported".into());
            }
        }
    }
    let mut asset_info_map = HashMap::new();
    let mut requested = BTreeMap::<String, u64>::new();
    for (id, outputs) in req["assignments"].as_object().ok_or("assignments")? {
        let mut output_map = HashMap::new();
        let mut total = 0u64;
        for (vout, amt) in outputs.as_object().ok_or("assignment outputs")? {
            let index: u32 = vout.parse()?;
            if index as usize >= psbt.outputs.len()
                || psbt.unsigned_tx.output[index as usize]
                    .script_pubkey
                    .is_op_return()
            {
                return Err("invalid RGB output".into());
            }
            let n = units(amt)?;
            total = total.checked_add(n).ok_or("amount overflow")?;
            output_map.insert(index, n);
        }
        requested.insert(id.clone(), total);
        asset_info_map.insert(
            ContractId::from_str(id)?,
            AssetColoringInfo {
                output_map,
                static_blinding: Some(777),
            },
        );
    }
    if owned.is_empty() || owned != requested {
        return Err(
            "all consumed allocations must be conserved, including unrelated assets".into(),
        );
    }
    let mut local = psbt.clone();
    for index in (0..local.inputs.len()).rev() {
        if !owned_points.contains(&local.unsigned_tx.input[index].previous_output) {
            local.inputs.remove(index);
            local.unsigned_tx.input.remove(index);
        }
    }
    // This input-filtered copy only builds RGB transitions. The original PSBT retains all prevouts.
    // The SDK explicitly supports missing input values for non-standard coloring templates.
    for input in &mut local.inputs {
        input.witness_utxo = None;
        input.non_witness_utxo = None;
    }
    let (fascia, _) = wallet.color_psbt(
        &mut local,
        ColoringInfo {
            asset_info_map,
            static_blinding: Some(777),
            nonce: Some(1),
        },
    )?;
    for (_, bundle) in local.rgb_bundles()? {
        for known in bundle.known_transitions {
            psbt.push_rgb_transition(known.transition)?;
        }
    }
    Ok(
        json!({"psbt":psbt.to_string(),"bundleCount":fascia.bundles().len(),"signed":false,
        "conservedAllocations":owned.iter().map(|(k,v)|(k,v.to_string())).collect::<BTreeMap<_,_>>() }),
    )
}
