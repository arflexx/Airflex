# AirFlex Soroban Smart Contract Error Codes

This document lists all error codes thrown by the AirFlex Escrow and Marketplace Soroban contracts.

## Error Codes Reference

| Error Code | Error Name | Description | Contract |
|---|---|---|---|
| `1` / `101` | `Unauthorized` | Caller is not authorized to perform this operation (e.g. missing signature or wrong role). | Escrow & Marketplace |
| `2` / `102` | `AlreadyInitialized` | The contract has already been initialized with an admin and parameters. | Escrow & Marketplace |
| `3` / `103` | `ContractPaused` | Operations are currently paused by the administrator emergency pause. | Escrow & Marketplace |
| `4` / `104` | `InvalidStatus` | The requested state transition is invalid for the current `TradeStatus` or `ListingStatus`. | Escrow & Marketplace |
| `5` / `105` | `TradeNotFound` / `ListingNotFound` | The specified trade ID or listing ID does not exist in persistent storage. | Escrow & Marketplace |
| `6` / `106` | `TokenNotAllowed` | The requested token address is not in the contract's allowed tokens whitelist. | Escrow |
| `7` / `107` | `InsufficientAmount` / `InvalidAmount` | The specified amount is zero, negative, or exceeds available fill balance. | Escrow & Marketplace |
| `8` / `108` | `ExpiryNotReached` | Attempted to trigger auto-cancellation or refund before the expiry timestamp. | Escrow & Marketplace |
| `9` / `109` | `AlreadyExpired` | Attempted to deposit or accept a listing after its expiry timestamp. | Escrow & Marketplace |
| `10` / `110` | `DisputeAlreadyFlagged` | A dispute has already been raised for this trade/listing. | Escrow & Marketplace |

## Handling Errors

When calling contract functions via Soroban SDK or RPC:
- Errors are returned as contract error host functions (`panic_with_error`).
- Client SDKs map these panic codes to corresponding `Error` enums for handling in frontend and server services.
