// Project-specific Rust-only bridge, appended to the pinned upstream rust_only.rs.
// No signing or broadcast occurs here; stock consumption is an explicit post-confirmation operation.
impl Wallet {
    /// Import a known confirmed transaction into local Bitcoin bookkeeping before consistency checks.
    /// This does not broadcast and does not skip the normal consistency check.
    #[cfg(any(feature = "electrum", feature = "esplora"))]
    pub fn cooperative_record_confirmed_tx(&mut self, raw: String) -> Result<(), Error> {
        let tx: BdkTransaction = bitcoin::consensus::deserialize(&hex::decode(raw)
            .map_err(|_| Error::InvalidTxid)?).map_err(|_| Error::InvalidTxid)?;
        let options = OnlineOptions { indexer_url:"127.0.0.1:50001".into(), skip_consistency_check:false, vanilla_sync_lookback:20 };
        let (_, data) = self.get_online_data(&options)?;
        *self.online_data_mut() = Some(data);
        if self.indexer().get_tx_confirmations(&tx.compute_txid().to_string())?.unwrap_or(0) == 0 {
            return Err(Error::InvalidTxid);
        }
        let txn = self.database().begin_transaction()?;
        self.bdk_wallet_mut().apply_unconfirmed_txs([(tx.clone(), now().unix_timestamp() as u64)]);
        self.flush_bdk_pending()?;
        self.update_db_colored_txos_from_bdk(&txn, false)?;
        for input in tx.input {
            let outpoint = Outpoint { txid:input.previous_output.txid.to_string(), vout:input.previous_output.vout };
            if let Some(txo) = txn.get_txo(&outpoint)? {
                let mut model: DbTxoActMod = txo.into();
                model.spent = ActiveValue::Set(true);
                txn.update_txo(model)?;
            }
        }
        self.update_backup_info(&txn,false)?;
        self.persist_and_commit(txn)?;
        Ok(())
    }

    /// Consume only contracts known to this wallet from the common committed fascia.
    pub fn cooperative_consume_known(&self, fascia: Fascia) -> Result<(), Error> {
        let mut runtime = self.rgb_runtime()?;
        let known: HashSet<_> = runtime.contracts()?.iter().map(|c|c.id).collect();
        let bundles: BTreeMap<_,_> = fascia.bundles().iter().filter(|(id,_)|known.contains(*id))
            .map(|(id,b)|(*id,b.clone())).collect();
        if !bundles.is_empty() {
            let filtered = Fascia::new(fascia.seal_witness().clone(), amplify::confinement::Confined::try_from_iter(bundles).map_err(InternalError::from)?);
            runtime.consume_fascia(filtered,None)?;
        }
        Ok(())
    }

    /// Return RGB stock amounts restricted to currently unspent outputs owned by this wallet.
    pub fn cooperative_stock_balances(&self) -> Result<BTreeMap<String,u64>, Error> {
        let runtime = self.rgb_runtime()?;
        let unspents: Vec<_> = self.bdk_wallet().list_unspent().map(|u|u.outpoint).collect();
        let mut balances = BTreeMap::new();
        for contract in runtime.contracts()? {
            let mut total=0u64;
            for (_,states) in runtime.contract_assignments_for(contract.id,unspents.iter().copied())? {
                for (_,state) in states {
                    if let AllocatedState::Amount(amount)=state {
                        total=total.checked_add(amount.as_u64()).ok_or(Error::InvalidConsignment)?;
                    }
                }
            }
            balances.insert(contract.id.to_string(),total);
        }
        Ok(balances)
    }

    /// Reveal a colored-chain address without creating a pending RGB receive.
    pub fn cooperative_colored_address(&mut self) -> Result<String, Error> {
        Ok(self.get_new_addresses(KeychainKind::External, 1)?.to_string())
    }

    /// Export a consignment from an unconsumed, jointly committed fascia.
    pub fn cooperative_consignment(
        &self, fascia: &Fascia, contract_id: ContractId, vouts: Vec<u32>,
    ) -> Result<RgbTransfer, Error> {
        let outputs = vouts.into_iter()
            .map(|vout| ExplicitSeal::with(fascia.witness_id(), vout)).collect::<Vec<_>>();
        Ok(self.rgb_runtime()?.transfer_from_fascia(contract_id, outputs, [], fascia)?)
    }

    #[cfg(any(feature = "electrum", feature = "esplora"))]
    /// Validate a tentative consignment without importing or consuming state.
    pub fn cooperative_validate(
        &self, online: Online, consignment: RgbTransfer, txid: String,
        contract_id: ContractId, vout: u32,
    ) -> Result<Vec<Assignment>, Error> {
        self.check_online(online)?;
        let witness_id = RgbTxid::from_str(&txid).map_err(|_| Error::InvalidTxid)?;
        if consignment.contract_id() != contract_id ||
            !consignment.bundled_witnesses().any(|b| b.witness_id() == witness_id && b.pub_witness.tx().is_some()) {
            return Err(Error::InvalidConsignment);
        }
        let schema: AssetSchema = consignment.schema_id().try_into()?;
        self.check_schema_support(&schema)?;
        let resolver = OffchainResolver { witness_id, consignment: &consignment, fallback: self.blockchain_resolver() };
        let config = ValidationConfig { chain_net:self.chain_net(), trusted_typesystem:schema.types(), ..Default::default() };
        consignment.clone().validate(&resolver, &config).map_err(|_| Error::InvalidConsignment)?;
        let assignments = self.extract_received_assignments(&consignment, witness_id, Some(vout), None);
        if assignments.is_empty() { return Err(Error::InvalidConsignment); }
        Ok(assignments.into_values().collect())
    }
}
