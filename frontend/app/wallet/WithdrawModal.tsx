"use client";

import { useState, useEffect } from "react";
import { getToken } from "../lib/auth";
import { CurrencyInput } from "../../components/CurrencyInput";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Bank {
  code: string;
  name: string;
}

interface ResolveAccountResponse {
  account_name?: string;
  error?: string;
}

interface WithdrawResponse {
  success?: boolean;
  error?: string;
}

interface WithdrawModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentBalance: string;
  onWithdrawSuccess: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WithdrawModal({
  isOpen,
  onClose,
  currentBalance,
  onWithdrawSuccess,
}: WithdrawModalProps) {
  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  // Form state
  const [amount, setAmount] = useState("");
  const [selectedBank, setSelectedBank] = useState<Bank | null>(null);
  const [accountNumber, setAccountNumber] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountConfirmed, setAccountConfirmed] = useState(false);

  // UI state
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankSearch, setBankSearch] = useState("");
  const [showBankDropdown, setShowBankDropdown] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Fetch banks on mount
  useEffect(() => {
    if (isOpen) {
      fetchBanks();
    }
  }, [isOpen]);

  async function fetchBanks() {
    try {
      const token = getToken();
      const res = await fetch(`${apiUrl}/api/v1/wallet/banks`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      if (data.banks) {
        setBanks(data.banks);
      }
    } catch (err) {
      console.error("Failed to fetch banks:", err);
    }
  }

  // Resolve account name when bank and account number are entered
  useEffect(() => {
    if (selectedBank && accountNumber.length === 10) {
      resolveAccount();
    } else {
      setAccountName("");
      setAccountConfirmed(false);
    }
  }, [selectedBank, accountNumber]);

  async function resolveAccount() {
    if (!selectedBank || accountNumber.length !== 10) return;

    setIsResolving(true);
    setError(null);
    setAccountName("");
    setAccountConfirmed(false);

    try {
      const token = getToken();
      const res = await fetch(
        `${apiUrl}/api/v1/wallet/resolve-account?account_number=${accountNumber}&bank_code=${selectedBank.code}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );
      const data = (await res.json()) as ResolveAccountResponse;

      if (data.account_name) {
        setAccountName(data.account_name);
      } else {
        setError(data.error || "Failed to resolve account name");
      }
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setIsResolving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!accountConfirmed) {
      setError("Please confirm the account name before proceeding.");
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError("Please enter a valid amount.");
      return;
    }

    const currentBalanceNum = parseFloat(currentBalance);
    if (amountNum > currentBalanceNum) {
      setError("Insufficient balance.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const token = getToken();
      const res = await fetch(`${apiUrl}/api/v1/wallet/withdraw`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          amount: amountNum,
          bank_code: selectedBank?.code,
          account_number: accountNumber,
          account_name: accountName,
        }),
      });

      const data = (await res.json()) as WithdrawResponse;

      if (data.success) {
        setSuccessMessage("Withdrawal request submitted successfully!");
        setTimeout(() => {
          onWithdrawSuccess();
          handleClose();
        }, 2000);
      } else {
        setError(data.error || "Failed to submit withdrawal request");
      }
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleClose() {
    setAmount("");
    setSelectedBank(null);
    setAccountNumber("");
    setAccountName("");
    setAccountConfirmed(false);
    setBankSearch("");
    setError(null);
    setSuccessMessage(null);
    onClose();
  }

  const filteredBanks = banks.filter((bank) =>
    bank.name.toLowerCase().includes(bankSearch.toLowerCase())
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="withdraw-modal-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-6 flex items-center justify-between">
          <h2
            id="withdraw-modal-title"
            className="text-xl font-bold text-gray-900 dark:text-gray-100"
          >
            Withdraw Funds
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            aria-label="Close modal"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Current balance display */}
        <div className="mb-6 rounded-xl bg-gray-50 p-4 dark:bg-gray-700">
          <p className="text-sm font-medium text-gray-500 dark:text-gray-400">
            Available Balance
          </p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            ₦{parseFloat(currentBalance).toLocaleString()}
          </p>
        </div>

        {/* Success message */}
        {successMessage && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400"
          >
            {successMessage}
          </div>
        )}

        {/* Error message */}
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Amount field */}
          <div>
            <label
              htmlFor="amount"
              className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Amount (₦)
            </label>
            <CurrencyInput
              id="amount"
              name="amount"
              value={amount}
              max={parseFloat(currentBalance) || undefined}
              onChange={(val) => setAmount(val ? String(val) : "")}
              placeholder="Enter amount"
            />
          </div>

          {/* Bank selection */}
          <div className="relative">
            <label
              htmlFor="bank"
              className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Bank
            </label>
            <div className="relative">
              <input
                type="text"
                id="bank"
                value={bankSearch}
                onChange={(e) => {
                  setBankSearch(e.target.value);
                  setShowBankDropdown(true);
                }}
                onFocus={() => setShowBankDropdown(true)}
                placeholder="Search bank..."
                required
                className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500"
              />
              {selectedBank && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedBank(null);
                    setBankSearch("");
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  aria-label="Clear bank selection"
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              )}
            </div>

            {/* Bank dropdown */}
            {showBankDropdown && filteredBanks.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-600 dark:bg-gray-700">
                {filteredBanks.map((bank) => (
                  <button
                    key={bank.code}
                    type="button"
                    onClick={() => {
                      setSelectedBank(bank);
                      setBankSearch(bank.name);
                      setShowBankDropdown(false);
                    }}
                    className="w-full px-4 py-2.5 text-left text-sm text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-600"
                  >
                    {bank.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Account number field */}
          <div>
            <label
              htmlFor="accountNumber"
              className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Account Number
            </label>
            <input
              type="text"
              id="accountNumber"
              value={accountNumber}
              onChange={(e) => {
                const value = e.target.value.replace(/\D/g, "").slice(0, 10);
                setAccountNumber(value);
              }}
              placeholder="10-digit account number"
              maxLength={10}
              required
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
            {isResolving && (
              <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                Resolving account name...
              </p>
            )}
          </div>

          {/* Account name confirmation */}
          {accountName && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-700">
              <p className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                Account Name
              </p>
              <p className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {accountName}
              </p>
              <label className="mt-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={accountConfirmed}
                  onChange={(e) => setAccountConfirmed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                />
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  I confirm this is the correct account name
                </span>
              </label>
            </div>
          )}

          {/* Submit button */}
          <button
            type="submit"
            disabled={
              isSubmitting ||
              !accountConfirmed ||
              !amount ||
              !selectedBank ||
              accountNumber.length !== 10
            }
            className="mt-2 inline-flex items-center justify-center rounded-xl bg-violet-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-gray-800"
          >
            {isSubmitting ? (
              <span className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 animate-spin"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"
                  />
                </svg>
                Processing...
              </span>
            ) : (
              "Withdraw"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
