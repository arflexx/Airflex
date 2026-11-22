import {
  NOTIFICATION_EMAIL_TEMPLATES,
  NOTIFICATION_TEMPLATES,
  MissingTemplateVariableError,
  escapeHtml,
  extractPlaceholders,
  renderNotification,
  renderTemplate,
  requiredVariables,
  type NotificationTemplateKey,
  type TemplatePayload,
} from "../services/notificationTemplates";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A complete payload for every template, keyed by template name. */
const FULL_PAYLOADS: Record<NotificationTemplateKey, TemplatePayload> = {
  TRADE_LOCKED: { tradeId: "trd_123" },
  TRADE_COMPLETED: { tradeId: "trd_123" },
  DISPUTE_FILED: { tradeId: "trd_123" },
  WITHDRAWAL_PROCESSED: { amount: 5000 },
  WITHDRAWAL_FAILED: { amount: 5000, reason: "Bank declined the transfer" },
  WEBHOOK_FAILED: { eventId: "evt_42", eventType: "charge.success" },
  DATA_EXPORT_READY: { days: 7 },
  KYC_DOCUMENT_EXPIRING: { expiryDate: "2026-12-31" },
  KYC_ADMIN_SUMMARY: { count: 4 },
};

const TEMPLATE_KEYS = Object.keys(NOTIFICATION_TEMPLATES) as NotificationTemplateKey[];

/** Exact SMS output for each template rendered with FULL_PAYLOADS. */
const EXPECTED_SMS: Record<NotificationTemplateKey, string> = {
  TRADE_LOCKED:
    "AirFlex: Your trade trd_123 has been locked. " +
    "The buyer's funds are secured in escrow. Deliver the airtime/data now.",
  TRADE_COMPLETED:
    "AirFlex: Payment released! Trade trd_123 is now complete. " +
    "Funds have been transferred to the seller's wallet.",
  DISPUTE_FILED:
    "AirFlex: Trade trd_123 has been escalated to a dispute. " +
    "Our team will review it and reach out within 24 hours.",
  WITHDRAWAL_PROCESSED:
    "AirFlex: Your withdrawal of 5000 has been processed and will arrive " +
    "in your bank account shortly.",
  WITHDRAWAL_FAILED:
    "AirFlex: Your withdrawal of 5000 has failed. Bank declined the transfer. " +
    "Your wallet balance has been restored.",
  WEBHOOK_FAILED:
    "AirFlex admin: Paystack webhook evt_42 (charge.success) failed after retries. " +
    "Inspect /api/admin/webhooks and replay if needed.",
  DATA_EXPORT_READY:
    "AirFlex: Your personal data export is ready. Download it from your " +
    "profile in the app within 7 days.",
  KYC_DOCUMENT_EXPIRING:
    "AirFlex: Your KYC document expires on 2026-12-31. Please renew it in the app to keep your account active.",
  KYC_ADMIN_SUMMARY:
    "AirFlex admin: 4 KYC document(s) are expired or expiring soon. Review the affected accounts.",
};

// ---------------------------------------------------------------------------
// HTML validation helper
// ---------------------------------------------------------------------------

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);

/**
 * Minimal well-formedness check: every opened tag is closed in LIFO order,
 * no stray closing tags, no unterminated `<`, and every `&` starts an entity.
 * Returns a list of problems (empty = valid).
 */
function htmlProblems(html: string): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^<>]*?(\/?)>/g;

  let lastIndex = 0;
  for (const match of html.matchAll(tagPattern)) {
    const between = html.slice(lastIndex, match.index);
    if (/[<>]/.test(between)) problems.push(`stray angle bracket in "${between}"`);
    lastIndex = match.index! + match[0].length;

    const [raw, rawName, selfClosing] = match;
    const name = rawName!.toLowerCase();
    if (raw.startsWith("</")) {
      const open = stack.pop();
      if (open !== name) problems.push(`</${name}> closes <${open ?? "nothing"}>`);
    } else if (!VOID_ELEMENTS.has(name) && selfClosing !== "/") {
      stack.push(name);
    }
  }

  const tail = html.slice(lastIndex);
  if (/[<>]/.test(tail)) problems.push(`stray angle bracket in "${tail}"`);
  for (const open of stack) problems.push(`unclosed <${open}>`);

  for (const amp of html.matchAll(/&(?!(?:[a-z]+|#\d+|#x[0-9a-f]+);)/gi)) {
    problems.push(`bare ampersand at offset ${amp.index}`);
  }
  return problems;
}

describe("htmlProblems (test helper sanity)", () => {
  it.each([
    ["<p>ok</p>", 0],
    ["<p>ok<br/></p>", 0],
    ["<p>unclosed", 1],
    ["<p><strong>misnested</p></strong>", 2],
    ["</p>", 1],
    ["<p>a < b</p>", 1],
    ["<p>Tom & Jerry</p>", 1],
  ])("%s → %i problem(s)", (html, count) => {
    expect(htmlProblems(html)).toHaveLength(count);
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notificationTemplates", () => {
  describe("template catalogue", () => {
    it("has a complete fixture payload for every template", () => {
      expect(Object.keys(FULL_PAYLOADS).sort()).toEqual([...TEMPLATE_KEYS].sort());
    });

    it("has an email (HTML + plain-text) counterpart for every SMS template", () => {
      expect(Object.keys(NOTIFICATION_EMAIL_TEMPLATES).sort()).toEqual(
        [...TEMPLATE_KEYS].sort()
      );
    });

    it.each(TEMPLATE_KEYS)(
      "%s: HTML body and plain-text fallback use the same placeholders",
      (key) => {
        const { html, text } = NOTIFICATION_EMAIL_TEMPLATES[key];
        expect(extractPlaceholders(html).sort()).toEqual(extractPlaceholders(text).sort());
      }
    );

    it.each(TEMPLATE_KEYS)("%s: plain-text fallback contains no markup", (key) => {
      expect(NOTIFICATION_EMAIL_TEMPLATES[key].text).not.toMatch(/<[^>]+>/);
    });

    it.each(TEMPLATE_KEYS)("%s: unrendered HTML template is well-formed", (key) => {
      expect(htmlProblems(NOTIFICATION_EMAIL_TEMPLATES[key].html)).toEqual([]);
    });
  });

  describe("extractPlaceholders", () => {
    it("returns unique placeholder names in first-seen order", () => {
      expect(extractPlaceholders("{a} then {b} then {a} and {c_1}")).toEqual(["a", "b", "c_1"]);
    });

    it("ignores braces that are not valid identifiers", () => {
      expect(extractPlaceholders("{} {1abc} { spaced } {ok}")).toEqual(["ok"]);
    });

    it("returns an empty list for a template with no placeholders", () => {
      expect(extractPlaceholders("plain text")).toEqual([]);
    });
  });

  describe("requiredVariables", () => {
    it.each(TEMPLATE_KEYS)("%s: lists exactly the keys of its full fixture", (key) => {
      expect(requiredVariables(key).sort()).toEqual(Object.keys(FULL_PAYLOADS[key]).sort());
    });
  });

  describe("renderTemplate", () => {
    it.each(TEMPLATE_KEYS)("%s: renders the exact SMS text with a full payload", (key) => {
      expect(renderTemplate(NOTIFICATION_TEMPLATES[key], FULL_PAYLOADS[key])).toBe(
        EXPECTED_SMS[key]
      );
    });

    it("replaces every occurrence of a repeated placeholder", () => {
      expect(renderTemplate("{x}-{x}-{x}", { x: "y" })).toBe("y-y-y");
    });

    it("stringifies numeric values, including zero", () => {
      expect(renderTemplate("amount={amount}", { amount: 0 })).toBe("amount=0");
    });

    it("ignores extra payload keys", () => {
      expect(renderTemplate("Hi {name}", { name: "Ada", unused: "x" })).toBe("Hi Ada");
    });

    it("does not re-expand placeholders that appear inside substituted values", () => {
      expect(renderTemplate("{a} {b}", { a: "{b}", b: "B" })).toBe("{b} B");
    });

    it("throws a descriptive MissingTemplateVariableError for an absent variable", () => {
      expect(() => renderTemplate(NOTIFICATION_TEMPLATES.TRADE_LOCKED, {})).toThrow(
        new MissingTemplateVariableError(["tradeId"])
      );
      expect(() => renderTemplate(NOTIFICATION_TEMPLATES.TRADE_LOCKED, {})).toThrow(
        "Missing template variable(s): tradeId"
      );
    });

    it("reports every missing variable, not just the first", () => {
      try {
        renderTemplate(NOTIFICATION_TEMPLATES.WEBHOOK_FAILED, {});
        throw new Error("expected renderTemplate to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingTemplateVariableError);
        expect(err).toBeInstanceOf(Error);
        expect((err as MissingTemplateVariableError).name).toBe("MissingTemplateVariableError");
        expect((err as MissingTemplateVariableError).missing).toEqual(["eventId", "eventType"]);
      }
    });

    it.each([
      ["empty string", ""],
      ["whitespace", "   "],
      ["undefined", undefined],
      ["null", null],
    ])("treats a %s value as missing", (_label, value) => {
      const payload = { amount: 100, reason: value } as unknown as TemplatePayload;
      expect(() => renderTemplate(NOTIFICATION_TEMPLATES.WITHDRAWAL_FAILED, payload)).toThrow(
        MissingTemplateVariableError
      );
    });

    it("never produces output containing an unreplaced placeholder", () => {
      for (const key of TEMPLATE_KEYS) {
        const out = renderTemplate(NOTIFICATION_TEMPLATES[key], FULL_PAYLOADS[key]);
        expect(out).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
      }
    });

    it("applies the escape function to each substituted value only", () => {
      expect(renderTemplate("<b>{v}</b>", { v: "<i>" }, escapeHtml)).toBe("<b>&lt;i&gt;</b>");
    });
  });

  describe("escapeHtml", () => {
    it("escapes all HTML-significant characters", () => {
      expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
        "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;"
      );
    });

    it("leaves safe text untouched", () => {
      expect(escapeHtml("trd_123 5000")).toBe("trd_123 5000");
    });
  });

  describe("renderNotification", () => {
    it.each(TEMPLATE_KEYS)("%s: renders all four variants with a full payload", (key) => {
      const rendered = renderNotification(key, FULL_PAYLOADS[key]);

      expect(rendered.sms).toBe(EXPECTED_SMS[key]);
      for (const value of Object.values(FULL_PAYLOADS[key])) {
        expect(rendered.subject + rendered.html + rendered.text + rendered.sms).toContain(
          String(value)
        );
        expect(rendered.text).toContain(String(value));
        expect(rendered.html).toContain(String(value));
      }
      for (const variant of Object.values(rendered)) {
        expect(variant).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
      }
    });

    it.each(TEMPLATE_KEYS)("%s: rendered HTML is well-formed with no unclosed tags", (key) => {
      expect(htmlProblems(renderNotification(key, FULL_PAYLOADS[key]).html)).toEqual([]);
    });

    it.each(TEMPLATE_KEYS)("%s: plain-text fallback renders without markup", (key) => {
      const { text } = renderNotification(key, FULL_PAYLOADS[key]);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/<[^>]+>/);
    });

    it("renders exact email output for a representative template", () => {
      expect(renderNotification("WITHDRAWAL_FAILED", FULL_PAYLOADS.WITHDRAWAL_FAILED)).toEqual({
        sms: EXPECTED_SMS.WITHDRAWAL_FAILED,
        subject: "AirFlex: Withdrawal failed",
        html:
          "<p>Your withdrawal of <strong>5000</strong> has failed.</p>" +
          "<p>Reason: <em>Bank declined the transfer</em></p>" +
          "<p>Your wallet balance has been restored.</p>",
        text:
          "Your withdrawal of 5000 has failed.\n\n" +
          "Reason: Bank declined the transfer\n\n" +
          "Your wallet balance has been restored.",
      });
    });

    it("HTML-escapes payload values in the HTML body but not in the plain text", () => {
      const reason = `<script>alert("x")</script> & more`;
      const rendered = renderNotification("WITHDRAWAL_FAILED", { amount: 10, reason });

      expect(rendered.html).not.toContain("<script>");
      expect(rendered.html).toContain(
        "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; more"
      );
      expect(htmlProblems(rendered.html)).toEqual([]);
      expect(rendered.text).toContain(reason);
    });

    it.each(TEMPLATE_KEYS)(
      "%s: throws listing every missing variable when the payload is empty",
      (key) => {
        expect(() => renderNotification(key, {})).toThrow(
          new MissingTemplateVariableError(requiredVariables(key))
        );
      }
    );

    it("throws before rendering any variant when one variable is missing", () => {
      expect(() => renderNotification("WITHDRAWAL_FAILED", { amount: 10 })).toThrow(
        "Missing template variable(s): reason"
      );
    });

    it("throws for an unknown template key", () => {
      expect(() =>
        renderNotification("NOT_A_TEMPLATE" as NotificationTemplateKey, { tradeId: "x" })
      ).toThrow("Unknown notification template: NOT_A_TEMPLATE");
    });
  });
});
