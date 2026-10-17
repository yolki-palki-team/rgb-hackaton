// Project-specific Rust-only bridge, appended to the pinned upstream rust_only.rs.
// No signing or broadcast occurs here; stock consumption is an explicit post-confirmation operation.
impl Wallet {
    /// Export public contract data for local verified asset discovery, without wallet keys.
    pub fn cooperative_export_contract(&self, id: ContractId) -> Result<RgbTransfer, Error> {
        Ok(self
            .rgb_runtime()?
            .transfer(id, Vec::<OutputSeal>::new(), [], None)?)
    }

    /// Validate and import public NIA contract metadata; this creates no owned allocation.
    #[cfg(any(feature = "electrum", feature = "esplora"))]
    pub fn cooperative_import_contract(&self, contract: RgbTransfer) -> Result<String, Error> {
        let id = contract.contract_id();
        let schema: AssetSchema = contract.schema_id().try_into()?;
        self.check_schema_support(&schema)?;
        let config = ValidationConfig {
            chain_net: self.chain_net(),
            trusted_typesystem: schema.types(),
            ..Default::default()
        };
        let valid = contract
            .validate(self.blockchain_resolver(), &config)
            .map_err(|_| Error::InvalidConsignment)?
            .into_valid_contract();
        let mut runtime = self.rgb_runtime()?;
        runtime.import_contract(valid.clone(), self.blockchain_resolver())?;
        let txn = self.database().begin_transaction()?;
        if txn.get_asset(id.to_string())?.is_none() {
            self.save_new_asset_internal(&txn, &runtime, id, schema, valid, None)?;
            self.update_backup_info(&txn, false)?;
        }
        txn.commit()?;
        Ok(id.to_string())
    }

    /// Reconcile a confirmed cooperative transaction into the SDK allocation index.
    /// Amounts come from validated RGB stock and prior settled SQL allocations, never a caller balance.
    #[cfg(any(feature = "electrum", feature = "esplora"))]
    pub fn cooperative_index_confirmed(&mut self, raw: String) -> Result<(), Error> {
        let tx: BdkTransaction =
            bitcoin::consensus::deserialize(&hex::decode(raw).map_err(|_| Error::InvalidTxid)?)
                .map_err(|_| Error::InvalidTxid)?;
        let txid = tx.compute_txid().to_string();
        if self.indexer().get_tx_confirmations(&txid)?.unwrap_or(0) == 0 {
            return Err(Error::InvalidTxid);
        }
        let txn = self.database().begin_transaction()?;
        // All rows are committed together; retry must not duplicate allocations.
        if !txn.get_batch_transfers_by_txid(&txid)?.is_empty() {
            txn.commit()?;
            return self.cooperative_check_index();
        }
        let data = txn.get_db_data(false)?;
        let mut consumed: BTreeMap<String, Vec<(i32, u64)>> = BTreeMap::new();
        for c in &data.colorings {
            if !c.incoming() {
                continue;
            }
            let at = data
                .asset_transfers
                .iter()
                .find(|a| a.idx == c.asset_transfer_idx)
                .ok_or(InternalError::Unexpected)?;
            let bt = data
                .batch_transfers
                .iter()
                .find(|b| b.idx == at.batch_transfer_idx)
                .ok_or(InternalError::Unexpected)?;
            if bt.status != TransferStatus::Settled {
                continue;
            }
            let old = data
                .txos
                .iter()
                .find(|t| t.idx == c.txo_idx)
                .ok_or(InternalError::Unexpected)?;
            if !tx.input.iter().any(|i| {
                i.previous_output.txid.to_string() == old.txid && i.previous_output.vout == old.vout
            }) {
                continue;
            }
            let Assignment::Fungible(amount) = c.assignment else {
                return Err(Error::InvalidConsignment);
            };
            consumed
                .entry(at.asset_id.clone().ok_or(InternalError::Unexpected)?)
                .or_default()
                .push((old.idx, amount));
        }
        let runtime = self.rgb_runtime()?;
        let owned: Vec<_> = self
            .bdk_wallet()
            .list_unspent()
            .filter(|u| u.outpoint.txid == tx.compute_txid())
            .map(|u| u.outpoint)
            .collect();
        let mut received: BTreeMap<String, Vec<(i32, u32, u64)>> = BTreeMap::new();
        for contract in runtime.contracts()? {
            for point in &owned {
                let mut total = 0u64;
                for (_, states) in runtime.contract_assignments_for(contract.id, [*point])? {
                    for (_, state) in states {
                        if let AllocatedState::Amount(n) = state {
                            total = total
                                .checked_add(n.as_u64())
                                .ok_or(Error::InvalidConsignment)?;
                        } else {
                            return Err(Error::InvalidConsignment);
                        }
                    }
                }
                if total > 0 {
                    let db = txn
                        .get_txo(&Outpoint {
                            txid: txid.clone(),
                            vout: point.vout,
                        })?
                        .ok_or(InternalError::Unexpected)?;
                    received
                        .entry(contract.id.to_string())
                        .or_default()
                        .push((db.idx, point.vout, total));
                }
            }
        }
        drop(runtime);
        let ids: std::collections::BTreeSet<_> =
            consumed.keys().chain(received.keys()).cloned().collect();
        for id in ids {
            txn.check_asset_exists(id.clone())?;
            let inputs = consumed.get(&id).cloned().unwrap_or_default();
            let outputs = received.get(&id).cloned().unwrap_or_default();
            let incoming = inputs.is_empty();
            let sum_in = inputs.iter().try_fold(0u64, |s, (_, n)| {
                s.checked_add(*n).ok_or(Error::InvalidConsignment)
            })?;
            let sum_out = outputs.iter().try_fold(0u64, |s, (_, _, n)| {
                s.checked_add(*n).ok_or(Error::InvalidConsignment)
            })?;
            if !incoming && sum_out > sum_in {
                return Err(Error::InvalidConsignment);
            }
            let batch = txn.set_batch_transfer(DbBatchTransferActMod {
                txid: ActiveValue::Set(Some(txid.clone())),
                status: ActiveValue::Set(TransferStatus::Settled),
                created_at: ActiveValue::Set(now().unix_timestamp()),
                expiration: ActiveValue::Set(None),
                min_confirmations: ActiveValue::Set(1),
                incoming: ActiveValue::Set(incoming),
                ..Default::default()
            })?;
            let at = txn.set_asset_transfer(DbAssetTransferActMod {
                asset_id: ActiveValue::Set(Some(id.clone())),
                batch_transfer_idx: ActiveValue::Set(batch),
                user_driven: ActiveValue::Set(incoming || sum_in != sum_out),
                ..Default::default()
            })?;
            for (idx, n) in inputs {
                txn.set_coloring(DbColoringActMod {
                    txo_idx: ActiveValue::Set(idx),
                    asset_transfer_idx: ActiveValue::Set(at),
                    r#type: ActiveValue::Set(ColoringType::Input),
                    assignment: ActiveValue::Set(Assignment::Fungible(n)),
                    ..Default::default()
                })?;
            }
            for (idx, _, n) in &outputs {
                txn.set_coloring(DbColoringActMod {
                    txo_idx: ActiveValue::Set(*idx),
                    asset_transfer_idx: ActiveValue::Set(at),
                    r#type: ActiveValue::Set(if incoming {
                        ColoringType::Receive
                    } else {
                        ColoringType::Change
                    }),
                    assignment: ActiveValue::Set(Assignment::Fungible(*n)),
                    ..Default::default()
                })?;
            }
            if incoming || sum_in != sum_out {
                txn.set_transfer(DbTransferActMod {
                    asset_transfer_idx: ActiveValue::Set(at),
                    requested_assignment: ActiveValue::Set(Some(Assignment::Fungible(
                        if incoming { sum_out } else { sum_in - sum_out },
                    ))),
                    recipient_id: ActiveValue::Set(Some(format!("cooperative:{txid}:{id}"))),
                    recipient_type: ActiveValue::Set(if incoming {
                        Some(RecipientTypeFull::Witness {
                            vout: Some(outputs[0].1),
                        })
                    } else {
                        None
                    }),
                    ack: ActiveValue::Set(Some(true)),
                    invoice_string: ActiveValue::Set(None),
                    ..Default::default()
                })?;
            }
        }
        // Check inside the transaction, so a mismatch rolls back every new row.
        for (id, actual) in self.cooperative_stock_balances()? {
            if txn
                .get_asset_balance(id, None, None, None, None, None)?
                .settled
                != actual
            {
                return Err(Error::InvalidConsignment);
            }
        }
        self.update_backup_info(&txn, false)?;
        self.persist_and_commit(txn)?;
        Ok(())
    }

    /// Verify SQL settled balances against validated stock on owned unspent outputs.
    pub fn cooperative_check_index(&self) -> Result<(), Error> {
        let txn = self.database().begin_transaction()?;
        for (id, actual) in self.cooperative_stock_balances()? {
            if txn
                .get_asset_balance(id, None, None, None, None, None)?
                .settled
                != actual
            {
                return Err(Error::InvalidConsignment);
            }
        }
        txn.commit()?;
        Ok(())
    }

    /// Persist consignment history at the path returned by the SDK transfer listing.
    pub fn cooperative_store_receipt(
        &self,
        txid: &str,
        contract: &str,
        incoming: bool,
        proof: RgbTransfer,
    ) -> Result<(), Error> {
        let path = if incoming {
            self.get_receive_consignment_path(&format!("cooperative:{txid}:{contract}"))
        } else {
            self.send_consignment_path(contract, txid)
        };
        std::fs::create_dir_all(path.parent().ok_or(InternalError::Unexpected)?)?;
        proof.save_file(path)?;
        Ok(())
    }

    /// Import a known confirmed transaction into local Bitcoin bookkeeping before consistency checks.
    /// This does not broadcast and does not skip the normal consistency check.
    #[cfg(any(feature = "electrum", feature = "esplora"))]
    pub fn cooperative_record_confirmed_tx(&mut self, raw: String) -> Result<(), Error> {
        let tx: BdkTransaction =
            bitcoin::consensus::deserialize(&hex::decode(raw).map_err(|_| Error::InvalidTxid)?)
                .map_err(|_| Error::InvalidTxid)?;
        let options = OnlineOptions {
            indexer_url: "127.0.0.1:50001".into(),
            skip_consistency_check: false,
            vanilla_sync_lookback: 20,
        };
        let (_, data) = self.get_online_data(&options)?;
        *self.online_data_mut() = Some(data);
        if self
            .indexer()
            .get_tx_confirmations(&tx.compute_txid().to_string())?
            .unwrap_or(0)
            == 0
        {
            return Err(Error::InvalidTxid);
        }
        let txn = self.database().begin_transaction()?;
        self.bdk_wallet_mut()
            .apply_unconfirmed_txs([(tx.clone(), now().unix_timestamp() as u64)]);
        self.flush_bdk_pending()?;
        self.update_db_colored_txos_from_bdk(&txn, false)?;
        for input in tx.input {
            let outpoint = Outpoint {
                txid: input.previous_output.txid.to_string(),
                vout: input.previous_output.vout,
            };
            if let Some(txo) = txn.get_txo(&outpoint)? {
                let mut model: DbTxoActMod = txo.into();
                model.spent = ActiveValue::Set(true);
                txn.update_txo(model)?;
            }
        }
        self.update_backup_info(&txn, false)?;
        self.persist_and_commit(txn)?;
        Ok(())
    }

    /// Consume only contracts known to this wallet from the common committed fascia.
    pub fn cooperative_consume_known(&self, fascia: Fascia) -> Result<(), Error> {
        let mut runtime = self.rgb_runtime()?;
        let known: HashSet<_> = runtime.contracts()?.iter().map(|c| c.id).collect();
        let bundles: BTreeMap<_, _> = fascia
            .bundles()
            .iter()
            .filter(|(id, _)| known.contains(*id))
            .map(|(id, b)| (*id, b.clone()))
            .collect();
        if !bundles.is_empty() {
            let filtered = Fascia::new(
                fascia.seal_witness().clone(),
                amplify::confinement::Confined::try_from_iter(bundles)
                    .map_err(InternalError::from)?,
            );
            runtime.consume_fascia(filtered, None)?;
        }
        Ok(())
    }

    /// Return RGB stock amounts restricted to currently unspent outputs owned by this wallet.
    pub fn cooperative_stock_balances(&self) -> Result<BTreeMap<String, u64>, Error> {
        let runtime = self.rgb_runtime()?;
        let unspents: Vec<_> = self
            .bdk_wallet()
            .list_unspent()
            .map(|u| u.outpoint)
            .collect();
        let mut balances = BTreeMap::new();
        for contract in runtime.contracts()? {
            let mut total = 0u64;
            for (_, states) in
                runtime.contract_assignments_for(contract.id, unspents.iter().copied())?
            {
                for (_, state) in states {
                    if let AllocatedState::Amount(amount) = state {
                        total = total
                            .checked_add(amount.as_u64())
                            .ok_or(Error::InvalidConsignment)?;
                    }
                }
            }
            balances.insert(contract.id.to_string(), total);
        }
        Ok(balances)
    }

    /// Reveal a colored-chain address without creating a pending RGB receive.
    pub fn cooperative_colored_address(&mut self) -> Result<String, Error> {
        Ok(self
            .get_new_addresses(KeychainKind::External, 1)?
            .to_string())
    }

    /// Export a consignment from an unconsumed, jointly committed fascia.
    pub fn cooperative_consignment(
        &self,
        fascia: &Fascia,
        contract_id: ContractId,
        vouts: Vec<u32>,
    ) -> Result<RgbTransfer, Error> {
        let outputs = vouts
            .into_iter()
            .map(|vout| ExplicitSeal::with(fascia.witness_id(), vout))
            .collect::<Vec<_>>();
        Ok(self
            .rgb_runtime()?
            .transfer_from_fascia(contract_id, outputs, [], fascia)?)
    }

    #[cfg(any(feature = "electrum", feature = "esplora"))]
    /// Validate a tentative consignment without importing or consuming state.
    pub fn cooperative_validate(
        &self,
        online: Online,
        consignment: RgbTransfer,
        txid: String,
        contract_id: ContractId,
        vout: u32,
    ) -> Result<Vec<Assignment>, Error> {
        self.check_online(online)?;
        let witness_id = RgbTxid::from_str(&txid).map_err(|_| Error::InvalidTxid)?;
        if consignment.contract_id() != contract_id
            || !consignment
                .bundled_witnesses()
                .any(|b| b.witness_id() == witness_id && b.pub_witness.tx().is_some())
        {
            return Err(Error::InvalidConsignment);
        }
        let schema: AssetSchema = consignment.schema_id().try_into()?;
        self.check_schema_support(&schema)?;
        let resolver = OffchainResolver {
            witness_id,
            consignment: &consignment,
            fallback: self.blockchain_resolver(),
        };
        let config = ValidationConfig {
            chain_net: self.chain_net(),
            trusted_typesystem: schema.types(),
            ..Default::default()
        };
        consignment
            .clone()
            .validate(&resolver, &config)
            .map_err(|_| Error::InvalidConsignment)?;
        let assignments =
            self.extract_received_assignments(&consignment, witness_id, Some(vout), None);
        if assignments.is_empty() {
            return Err(Error::InvalidConsignment);
        }
        Ok(assignments.into_values().collect())
    }
}
