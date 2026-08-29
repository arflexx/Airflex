/**
 * openapi.ts — OpenAPI 3.1 specification for the AirFlex API.
 *
 * The spec is hand-authored from the Zod schemas in src/schemas/ and kept in
 * sync with the route implementations. A CI check (scripts/check-openapi.ts)
 * regenerates and diffs the committed openapi.json to catch drift.
 *
 * Swagger UI is served at GET /api/docs (disabled in production unless
 * ENABLE_API_DOCS=true). The raw JSON document is always available at
 * GET /api/docs.json for tooling consumption.
 */

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "AirFlex API",
    version: "1.0.0",
    description:
      "Open-source P2P Airtime & Data Exchange Marketplace backed by the Stellar Network. " +
      "All protected endpoints require a Bearer JWT obtained from POST /api/v1/auth/verify-otp.",
    contact: {
      name: "AirFlex Core Team",
      url: "https://github.com/arflexx/Airflex",
    },
    license: {
      name: "MIT",
      url: "https://opensource.org/licenses/MIT",
    },
  },
  servers: [
    {
      url: "/",
      description: "Current server",
    },
  ],

  // ---------------------------------------------------------------------------
  // Security schemes
  // ---------------------------------------------------------------------------
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "JWT issued by POST /api/v1/auth/verify-otp. Pass as `Authorization: Bearer <token>`.",
      },
    },
    schemas: {
      // ------------------------------------------------------------------
      // Generic wrappers
      // ------------------------------------------------------------------
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string", example: "Descriptive error message" },
        },
      },
      ValidationErrorItem: {
        type: "object",
        required: ["field", "message"],
        properties: {
          field: { type: "string", example: "phone" },
          message: { type: "string", example: "phone is required" },
        },
      },
      ValidationErrorResponse: {
        type: "object",
        required: ["errors"],
        properties: {
          errors: {
            type: "array",
            items: { $ref: "#/components/schemas/ValidationErrorItem" },
          },
        },
      },
      PaginationMeta: {
        type: "object",
        required: ["page", "limit", "total", "totalPages"],
        properties: {
          page: { type: "integer", example: 1 },
          limit: { type: "integer", example: 20 },
          total: { type: "integer", example: 100 },
          totalPages: { type: "integer", example: 5 },
        },
      },

      // ------------------------------------------------------------------
      // Auth
      // ------------------------------------------------------------------
      RequestOtpBody: {
        type: "object",
        required: ["phone"],
        properties: {
          phone: {
            type: "string",
            description:
              "E.164 or Nigerian local format (0XXXXXXXXXX). 10–15 digits.",
            example: "+2348012345678",
          },
        },
      },
      VerifyOtpBody: {
        type: "object",
        required: ["phone", "otp"],
        properties: {
          phone: { type: "string", example: "+2348012345678" },
          otp: {
            type: "string",
            minLength: 6,
            maxLength: 6,
            pattern: "^\\d{6}$",
            example: "123456",
          },
        },
      },
      AuthTokenResponse: {
        type: "object",
        required: ["token", "user"],
        properties: {
          token: {
            type: "string",
            description: "Signed JWT — valid for 7 days.",
            example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
          },
          user: {
            type: "object",
            required: ["id", "phone", "stellarPublicKey"],
            properties: {
              id: { type: "string", format: "uuid" },
              phone: { type: "string", example: "+2348012345678" },
              stellarPublicKey: {
                type: "string",
                example: "GABC1234...",
              },
            },
          },
          recoveryCodes: {
            type: "array",
            items: { type: "string", example: "ABC23456789ABCDE" },
            description:
              "8 single-use backup codes. Present ONLY on the very first signup " +
              "(issue #108) — never on later logins.",
          },
        },
      },
      RecoverBody: {
        type: "object",
        required: ["recoveryCode"],
        properties: {
          recoveryCode: {
            type: "string",
            minLength: 16,
            maxLength: 16,
            pattern: "^[A-Za-z0-9]{16}$",
            description: "A single-use backup code issued at signup (issue #108).",
            example: "ABC23456789ABCDE",
          },
        },
      },
      RecoveryTokenResponse: {
        type: "object",
        required: ["token", "message", "expiresIn"],
        properties: {
          token: {
            type: "string",
            description: "One-time JWT (15 min) scoped to recovery — present it to POST /api/v1/auth/recover/change-phone.",
          },
          message: { type: "string" },
          expiresIn: { type: "string", example: "15m" },
        },
      },
      ChangePhoneBody: {
        type: "object",
        required: ["token", "newPhone"],
        properties: {
          token: {
            type: "string",
            description: "The one-time recovery JWT from POST /api/v1/auth/recover.",
          },
          newPhone: {
            type: "string",
            description: "E.164 or Nigerian local format (0XXXXXXXXXX). 10–15 digits.",
            example: "+2348098765432",
          },
        },
      },
      RecoveryStatusResponse: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "object",
            required: ["remaining"],
            properties: {
              remaining: {
                type: "integer",
                description: "How many backup codes remain unused (issue #108).",
                example: 8,
              },
            },
          },
        },
      },

      // ------------------------------------------------------------------
      // Trade
      // ------------------------------------------------------------------
      TradeStatus: {
        type: "string",
        enum: ["Active", "Locked", "Completed", "Cancelled", "Disputed"],
      },
      TradeOffer: {
        type: "object",
        required: [
          "id",
          "seller_id",
          "asset_type",
          "amount",
          "status",
          "expires_at",
          "created_at",
          "updated_at",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          seller_id: { type: "string", format: "uuid" },
          buyer_id: {
            type: ["string", "null"],
            format: "uuid",
            nullable: true,
          },
          asset_type: { type: "string", example: "MTN_AIRTIME" },
          amount: { type: "number", example: 500 },
          status: { $ref: "#/components/schemas/TradeStatus" },
          contract_listing_id: {
            type: ["string", "null"],
            nullable: true,
            example: "42",
          },
          escrow_tx_hash: {
            type: ["string", "null"],
            nullable: true,
            example: "abc123txhash",
          },
          expires_at: { type: "string", format: "date-time" },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      CreateTradeBody: {
        type: "object",
        required: ["assetType", "amount", "expiresInHours"],
        properties: {
          assetType: {
            type: "string",
            maxLength: 50,
            pattern: "^[A-Za-z0-9_-]+$",
            example: "MTN_AIRTIME",
          },
          amount: {
            type: "number",
            exclusiveMinimum: 0,
            example: 500,
          },
          expiresInHours: {
            type: "integer",
            minimum: 1,
            maximum: 168,
            example: 24,
          },
        },
      },
      BuyTradeBody: {
        type: "object",
        required: ["buyerSecretKey"],
        properties: {
          buyerSecretKey: {
            type: "string",
            minLength: 56,
            maxLength: 56,
            description:
              "Stellar secret key (S...). 56 characters. " +
              "NOTE: client-side XDR signing is preferred in production.",
            example: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          },
        },
      },
      TradeListResponse: {
        type: "object",
        required: ["data", "pagination"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/TradeOffer" },
          },
          pagination: { $ref: "#/components/schemas/PaginationMeta" },
        },
      },

      // ------------------------------------------------------------------
      // Wallet
      // ------------------------------------------------------------------
      WalletResponse: {
        type: "object",
        required: ["publicKey", "balance", "asset", "network"],
        properties: {
          publicKey: { type: "string", example: "GABC1234..." },
          balance: {
            type: "string",
            description: "XLM balance as a decimal string.",
            example: "10000.0000000",
          },
          asset: { type: "string", example: "XLM" },
          network: { type: "string", example: "testnet" },
        },
      },
      Bank: {
        type: "object",
        required: ["code", "name"],
        properties: {
          code: { type: "string", example: "058" },
          name: { type: "string", example: "Guaranty Trust Bank" },
        },
      },
      BanksResponse: {
        type: "object",
        required: ["banks"],
        properties: {
          banks: {
            type: "array",
            items: { $ref: "#/components/schemas/Bank" },
          },
        },
      },
      ResolveAccountResponse: {
        type: "object",
        required: ["account_name"],
        properties: {
          account_name: { type: "string", example: "JOHN DOE" },
        },
      },
      WithdrawBody: {
        type: "object",
        required: ["amount", "bank_code", "account_number", "account_name"],
        properties: {
          amount: { type: "number", exclusiveMinimum: 0, example: 1000 },
          bank_code: { type: "string", example: "058" },
          account_number: { type: "string", example: "0123456789" },
          account_name: { type: "string", example: "JOHN DOE" },
        },
      },

      // ------------------------------------------------------------------
      // Profile
      // ------------------------------------------------------------------
      ProfileResponse: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "object",
            required: [
              "id",
              "maskedPhone",
              "createdAt",
              "totalTradesCompleted",
              "role",
              "kycStatus",
              "virtualAccountNumber",
              "stellarPublicKey",
            ],
            properties: {
              id: { type: "string", format: "uuid" },
              maskedPhone: {
                type: "string",
                example: "+234 *** *** 5678",
              },
              createdAt: { type: "string", format: "date-time" },
              totalTradesCompleted: { type: "integer", example: 5 },
              role: { type: "string", example: "user" },
              kycStatus: { type: "string", enum: ["unverified", "pending", "verified"] },
              virtualAccountNumber: { type: "string", example: "0123456789" },
              stellarPublicKey: { type: "string", example: "GABC1234..." },
            },
          },
        },
      },
      ProfileTradesResponse: {
        type: "object",
        required: ["data", "pagination"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/TradeOffer" },
          },
          pagination: { $ref: "#/components/schemas/PaginationMeta" },
        },
      },
      DeleteAccountResponse: {
        type: "object",
        required: ["message", "scheduledDeletionAt"],
        properties: {
          message: {
            type: "string",
            example:
              "Account deletion requested. Your account will be anonymised in 30 days.",
          },
          scheduledDeletionAt: {
            type: "string",
            format: "date-time",
            description: "ISO timestamp 30 days from now.",
          },
        },
      },
      DeletionStatusResponse: {
        type: "object",
        required: ["pendingDeletion"],
        properties: {
          pendingDeletion: { type: "boolean" },
          scheduledDeletionAt: {
            type: ["string", "null"],
            format: "date-time",
            nullable: true,
          },
        },
      },

      // ------------------------------------------------------------------
      // Admin
      // ------------------------------------------------------------------
      QueueStats: {
        type: "object",
        required: ["name", "waiting", "active", "completed", "failed", "delayed"],
        properties: {
          name: { type: "string", example: "fund-stellar-account" },
          waiting: { type: "integer", example: 0 },
          active: { type: "integer", example: 1 },
          completed: { type: "integer", example: 42 },
          failed: { type: "integer", example: 2 },
          delayed: { type: "integer", example: 0 },
          recentFailures: {
            type: "array",
            items: {
              type: "object",
              properties: {
                jobId: { type: "string" },
                data: { type: "object" },
                failedReason: { type: "string" },
                timestamp: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
      QueuesResponse: {
        type: "object",
        required: ["queues"],
        properties: {
          queues: {
            type: "array",
            items: { $ref: "#/components/schemas/QueueStats" },
          },
        },
      },
      AnalyticsOverview: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "object",
            required: [
              "totalUsers",
              "totalTrades",
              "tradeVolume",
              "feeRevenue",
              "successRate",
            ],
            properties: {
              totalUsers: { type: "integer", example: 1240 },
              totalTrades: { type: "integer", example: 860 },
              tradeVolume: { type: "number", example: 482500 },
              feeRevenue: { type: "number", example: 9650 },
              successRate: { type: "number", example: 87.5 },
            },
          },
        },
      },
      AnalyticsTimeseriesPoint: {
        type: "object",
        required: ["date", "tradeCount", "volume"],
        properties: {
          date: { type: "string", format: "date", example: "2026-08-01" },
          tradeCount: { type: "integer", example: 42 },
          volume: { type: "number", example: 21000 },
        },
      },
      AnalyticsTimeseriesResponse: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "array",
            items: { $ref: "#/components/schemas/AnalyticsTimeseriesPoint" },
          },
        },
      },
      AnalyticsAssetsResponse: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "array",
            items: {
              type: "object",
              required: ["assetType", "tradeCount", "volume"],
              properties: {
                assetType: { type: "string", example: "MTN_AIRTIME" },
                tradeCount: { type: "integer", example: 310 },
                volume: { type: "number", example: 155000 },
              },
            },
          },
        },
      },
    },

    // ------------------------------------------------------------------
    // Reusable responses
    // ------------------------------------------------------------------
    responses: {
      Unauthorized: {
        description: "Missing or invalid Bearer JWT.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
            example: { error: "Missing or invalid Authorization header" },
          },
        },
      },
      Forbidden: {
        description: "Authenticated but not permitted to perform this action.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
            example: { error: "Only the seller can confirm delivery" },
          },
        },
      },
      NotFound: {
        description: "The requested resource does not exist.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
            example: { error: "Trade offer not found" },
          },
        },
      },
      UnprocessableEntity: {
        description: "Request body failed schema validation.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ValidationErrorResponse" },
          },
        },
      },
      TooManyRequests: {
        description: "Rate limit exceeded.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
            example: { error: "Too many requests. Please slow down." },
          },
        },
      },
      InternalError: {
        description: "Unexpected server error.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ErrorResponse" },
            example: { error: "Internal server error" },
          },
        },
      },
    },
  },

  // Global security — overridden per-endpoint where auth is not required
  security: [{ bearerAuth: [] }],

  // ---------------------------------------------------------------------------
  // Paths
  // ---------------------------------------------------------------------------
  paths: {
    // ------------------------------------------------------------------ Health
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Liveness probe",
        description: "Returns 200 when the server process is running.",
        security: [],
        responses: {
          "200": {
            description: "Server is alive.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    timestamp: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/ready": {
      get: {
        tags: ["Health"],
        summary: "Readiness probe",
        description: "Returns 200 when the server and database are ready to serve traffic.",
        security: [],
        responses: {
          "200": {
            description: "Server and DB are ready.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ready" },
                    db: { type: "string", example: "ok" },
                  },
                },
              },
            },
          },
          "503": {
            description: "Database not reachable.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "not ready" },
                    db: { type: "string", example: "error" },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ------------------------------------------------------------------ Auth
    "/api/v1/auth/request-otp": {
      post: {
        tags: ["Auth"],
        summary: "Request OTP",
        description:
          "Sends a 6-digit OTP to the provided phone number via Termii SMS. " +
          "Creates a new user record on first call (upsert).",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RequestOtpBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "OTP sent successfully.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string", example: "OTP sent successfully" },
                  },
                },
              },
            },
          },
          "422": { $ref: "#/components/responses/UnprocessableEntity" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
          "500": { $ref: "#/components/responses/InternalError" },
          "502": {
            description: "Termii SMS service unavailable.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
                example: { error: "Failed to send OTP. Please try again." },
              },
            },
          },
        },
      },
    },
    "/api/v1/auth/verify-otp": {
      post: {
        tags: ["Auth"],
        summary: "Verify OTP and obtain JWT",
        description:
          "Verifies the OTP against Termii. On success issues a 7-day JWT and " +
          "provisions a Stellar wallet for new users.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/VerifyOtpBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "OTP verified — JWT issued.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AuthTokenResponse" },
              },
            },
          },
          "400": {
            description: "Invalid or expired OTP.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "422": { $ref: "#/components/responses/UnprocessableEntity" },
          "500": { $ref: "#/components/responses/InternalError" },
          "502": {
            description: "Termii verification service unavailable.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/v1/auth/recover": {
      post: {
        tags: ["Auth"],
        summary: "Recover account with a backup code",
        description:
          "Redeems a single-use backup code (issue #108) and returns a short-lived " +
          "one-time token that can be used to register a new phone number. " +
          "5 failed attempts from the same IP within 1 hour trigger a 429 lockout.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RecoverBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Code accepted — one-time recovery token issued.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RecoveryTokenResponse" },
              },
            },
          },
          "401": {
            description: "Invalid or already-used recovery code.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "422": { $ref: "#/components/responses/UnprocessableEntity" },
          "429": { $ref: "#/components/responses/TooManyRequests" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/auth/recover/change-phone": {
      post: {
        tags: ["Auth"],
        summary: "Register a new phone number after recovery",
        description:
          "Presents the one-time recovery token from POST /api/v1/auth/recover " +
          "and moves the account to a new phone number (issue #108). Returns a " +
          "fresh session JWT so the user is signed in immediately.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ChangePhoneBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Phone number updated — session JWT issued.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AuthTokenResponse" },
              },
            },
          },
          "401": {
            description: "Recovery token is invalid, expired, or not recovery-scoped.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": {
            description: "The new phone number is already registered to another account.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "422": { $ref: "#/components/responses/UnprocessableEntity" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/auth/recovery-codes/status": {
      get: {
        tags: ["Auth"],
        summary: "Check remaining recovery codes",
        description:
          "Returns how many backup codes remain unused for the authenticated user " +
          "(issue #108). The codes themselves are never revealed.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Remaining code count.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RecoveryStatusResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },

    // ------------------------------------------------------------------ Trades
    "/api/v1/trades": {
      get: {
        tags: ["Trades"],
        summary: "List active trade offers",
        description: "Returns paginated active listings that have not expired.",
        security: [],
        parameters: [
          {
            name: "page",
            in: "query",
            schema: { type: "integer", minimum: 1, default: 1 },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          "200": {
            description: "Paginated list of active trade offers.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TradeListResponse" },
              },
            },
          },
          "400": {
            description: "Invalid query parameters.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
      post: {
        tags: ["Trades"],
        summary: "Create a trade offer",
        description:
          "Creates a new trade listing. Calls `create_listing` on the Soroban escrow contract " +
          "and stores the resulting on-chain listing ID.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateTradeBody" },
            },
          },
        },
        responses: {
          "201": {
            description: "Trade offer created.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { $ref: "#/components/schemas/TradeOffer" },
                  },
                },
              },
            },
          },
          "400": {
            description: "Seller wallet not found or contract call failed.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "422": { $ref: "#/components/responses/UnprocessableEntity" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/trades/{id}": {
      get: {
        tags: ["Trades"],
        summary: "Get trade by ID",
        security: [],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Trade offer found.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { $ref: "#/components/schemas/TradeOffer" },
                  },
                },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/trades/{id}/buy": {
      post: {
        tags: ["Trades"],
        summary: "Buy a trade offer",
        description:
          "Locks the buyer's funds in the Soroban escrow contract via `deposit_to_escrow`. " +
          "Trade status transitions to Locked.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BuyTradeBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Escrow deposit confirmed — trade is now Locked.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { $ref: "#/components/schemas/TradeOffer" },
                  },
                },
              },
            },
          },
          "400": {
            description: "Trade not available, already locked, or buyer is the seller.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "422": { $ref: "#/components/responses/UnprocessableEntity" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/trades/{id}/confirm-delivery": {
      post: {
        tags: ["Trades"],
        summary: "Confirm delivery (seller only)",
        description:
          "Signals that the seller has delivered the airtime/data. Returns 202 immediately. " +
          "Payment release runs asynchronously via the Soroban `release_payment` call " +
          "with up to 3 retry attempts. Parties are notified via SSE.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "202": {
            description: "Delivery confirmation accepted — payment release in progress.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string" },
                    tradeId: { type: "string", format: "uuid" },
                  },
                },
              },
            },
          },
          "400": {
            description: "Trade not in Locked state.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },

    // ------------------------------------------------------------------ Wallet
    "/api/v1/wallet": {
      get: {
        tags: ["Wallet"],
        summary: "Get wallet balance",
        description:
          "Returns the authenticated user's Stellar public key and current XLM balance " +
          "fetched from Horizon. The secret key is never returned.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Wallet details.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WalletResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "500": { $ref: "#/components/responses/InternalError" },
          "502": {
            description: "Horizon RPC unavailable.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/v1/wallet/banks": {
      get: {
        tags: ["Wallet"],
        summary: "List Nigerian banks",
        description: "Returns Paystack's list of Nigerian banks for account number resolution.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Bank list.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BanksResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "500": { $ref: "#/components/responses/InternalError" },
          "502": {
            description: "Paystack API unavailable.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/v1/wallet/resolve-account": {
      get: {
        tags: ["Wallet"],
        summary: "Resolve bank account name",
        description: "Resolves a Nigerian bank account number to the account holder name via Paystack.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "account_number",
            in: "query",
            required: true,
            schema: { type: "string", example: "0123456789" },
          },
          {
            name: "bank_code",
            in: "query",
            required: true,
            schema: { type: "string", example: "058" },
          },
        ],
        responses: {
          "200": {
            description: "Account name resolved.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ResolveAccountResponse" },
              },
            },
          },
          "400": {
            description: "Missing or invalid query parameters.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "500": { $ref: "#/components/responses/InternalError" },
          "502": {
            description: "Paystack API unavailable.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/api/v1/wallet/withdraw": {
      post: {
        tags: ["Wallet"],
        summary: "Withdraw to bank account",
        description: "Initiates a withdrawal to a Nigerian bank account via Paystack.",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WithdrawBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Withdrawal initiated successfully.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { success: { type: "boolean", example: true } },
                },
              },
            },
          },
          "400": {
            description: "Invalid input or insufficient balance.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },

    // ------------------------------------------------------------------ Profile
    "/api/v1/profile": {
      patch: {
        tags: ["Profile"],
        summary: "Update own profile",
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            properties: {
              alias: { type: "string", maxLength: 30, pattern: "^[A-Za-z0-9]+$" },
              notificationsEnabled: { type: "boolean" },
            },
            additionalProperties: false,
          } } },
        },
        responses: { "200": { description: "Profile updated." }, "400": { $ref: "#/components/responses/ErrorResponse" }, "401": { $ref: "#/components/responses/Unauthorized" }, "422": { $ref: "#/components/responses/UnprocessableEntity" } },
      },
      get: {
        tags: ["Profile"],
        summary: "Get own profile",
        description:
          "Returns the authenticated user's profile metadata. Phone is masked.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Profile data.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProfileResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
      delete: {
        tags: ["Profile"],
        summary: "Request account deletion (GDPR/NDPR)",
        description:
          "Initiates a 30-day soft-delete grace period. The account is marked " +
          "`pending_deletion`. After 30 days all PII is anonymised. " +
          "All pending trades are cancelled and escrow refunds are triggered. " +
          "A confirmation SMS is sent via Termii.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Deletion request accepted.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeleteAccountResponse" },
              },
            },
          },
          "400": {
            description: "Account deletion already pending.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/profile/trades": {
      get: {
        tags: ["Profile"],
        summary: "Get own trade history",
        description:
          "Returns paginated trade history for the authenticated user " +
          "(as seller or buyer). Filterable by status.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "page",
            in: "query",
            schema: { type: "integer", minimum: 1, default: 1 },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          },
          {
            name: "status",
            in: "query",
            schema: {
              type: "string",
              enum: ["All", "Active", "Locked", "Completed", "Cancelled", "Disputed"],
              default: "All",
            },
          },
        ],
        responses: {
          "200": {
            description: "Paginated trade history.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProfileTradesResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/profile/deletion-status": {
      get: {
        tags: ["Profile"],
        summary: "Check account deletion status",
        description: "Returns whether the account has a pending deletion request and when it is scheduled.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Deletion status.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeletionStatusResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/profile/cancel-deletion": {
      post: {
        tags: ["Profile"],
        summary: "Cancel pending account deletion",
        description: "Cancels a pending 30-day deletion request within the grace window.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Deletion request cancelled successfully.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: {
                      type: "string",
                      example: "Account deletion cancelled. Your account is restored.",
                    },
                  },
                },
              },
            },
          },
          "400": {
            description: "No pending deletion request to cancel.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },

    // ------------------------------------------------------------------ Events
    "/api/events": {
      get: {
        tags: ["Events"],
        summary: "Server-Sent Events stream",
        description:
          "Persistent SSE connection for real-time trade status updates. " +
          "Event types: `connected`, `trade_completed`, `trade_disputed`, `admin_alert`.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "SSE stream opened.",
            content: {
              "text/event-stream": {
                schema: { type: "string" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },

    // ------------------------------------------------------------------ Admin
    "/api/v1/admin/users/{id}/kyc": {
      patch: {
        tags: ["Admin"],
        summary: "Update user KYC status",
        security: [{ bearerAuth: [] }],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["unverified", "pending", "verified"] } } } } } },
        responses: { "200": { description: "KYC status updated." }, "401": { $ref: "#/components/responses/Unauthorized" }, "403": { $ref: "#/components/responses/Forbidden" }, "404": { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/api/v1/admin/queues": {
      get: {
        tags: ["Admin"],
        summary: "Job queue metrics",
        description:
          "Returns queue depths and recent failure counts for all BullMQ job queues. " +
          "Admin access required.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Queue stats for all job types.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/QueuesResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/admin/analytics/overview": {
      get: {
        tags: ["Admin"],
        summary: "Platform analytics overview",
        description:
          "Platform-level metrics for the admin dashboard (issue #110): total users, " +
          "total trades, completed trade volume, platform fee revenue, and success " +
          "rate. Cached in Redis for 5 minutes.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Platform metrics.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AnalyticsOverview" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/admin/analytics/trades/timeseries": {
      get: {
        tags: ["Admin"],
        summary: "Daily trade volume timeseries",
        description:
          "Daily trade counts and volume for the range [?from, ?to] (issue #110). " +
          "Both params are ISO-8601 dates; they default to the last 30 days. " +
          "Cached in Redis for 5 minutes.",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "from",
            in: "query",
            schema: {
              type: "string",
              format: "date",
              example: "2026-08-01",
            },
          },
          {
            name: "to",
            in: "query",
            schema: {
              type: "string",
              format: "date",
              example: "2026-08-28",
            },
          },
        ],
        responses: {
          "200": {
            description: "Daily trade counts and volume.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AnalyticsTimeseriesResponse" },
              },
            },
          },
          "400": {
            description: "Invalid query parameters.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
    "/api/v1/admin/analytics/assets": {
      get: {
        tags: ["Admin"],
        summary: "Per-asset-type trade breakdown",
        description:
          "Trade counts and volume grouped by asset_type (issue #110), ordered by " +
          "volume. Cached in Redis for 5 minutes.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Per-asset breakdown.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AnalyticsAssetsResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
  },

  tags: [
    { name: "Health", description: "Liveness and readiness probes" },
    { name: "Auth", description: "OTP-based phone authentication" },
    { name: "Trades", description: "P2P trade offer marketplace" },
    { name: "Wallet", description: "Stellar wallet and Paystack withdrawals" },
    { name: "Profile", description: "User profile and account management" },
    { name: "Events", description: "Real-time Server-Sent Events stream" },
    { name: "Admin", description: "Platform administration and monitoring" },
  ],
} as const;
