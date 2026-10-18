"""Allowlisted public wallet failures; never expose native diagnostics to the UI."""


class WalletUpgradeRequired(ValueError):
    code = "WALLET_UPGRADE_REQUIRED"
    public_message = "The native wallet is outdated. Rebuild the native wallet and restart every participant's app."

    def __init__(self):
        super().__init__(self.public_message)


class WalletPreparationConflict(ValueError):
    code = "WALLET_PREPARATION_CONFLICT"
    public_message = (
        "Saved RGB preparation contains conflicting inputs. Update and rebuild every participant's "
        "wallet, cancel this unsigned swap, then publish new orders."
    )

    def __init__(self):
        super().__init__(self.public_message)
