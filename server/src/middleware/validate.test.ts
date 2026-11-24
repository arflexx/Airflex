/**
 * validate.test.ts
 *
 * Unit tests for the validate() middleware factory and formatErrors() helper.
 * Tests use lightweight Express apps built inline — no database or external
 * service is touched.
 */

import express, { Request, Response } from "express";
import request from "supertest";
import { z } from "zod";
import { validate, formatErrors } from "./validate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Express app with one POST route using the given schema. */
function makeApp(schema: z.ZodSchema) {
  const app = express();
  app.use(express.json());
  app.post(
    "/test",
    validate(schema),
    (_req: Request, res: Response) => {
      res.status(200).json({ ok: true, body: _req.body });
    }
  );
  return app;
}

// ---------------------------------------------------------------------------
// formatErrors
// ---------------------------------------------------------------------------

describe("formatErrors", () => {
  it("maps a top-level issue to field '_body'", () => {
    const schema = z.string();
    const result = schema.safeParse(123);
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = formatErrors(result.error);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.field).toBe("_body");
      expect(typeof errors[0]!.message).toBe("string");
    }
  });

  it("maps a nested issue to a dot-notation path", () => {
    const schema = z.object({ address: z.object({ city: z.string() }) });
    const result = schema.safeParse({ address: { city: 123 } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = formatErrors(result.error);
      expect(errors[0]!.field).toBe("address.city");
    }
  });

  it("maps multiple issues to separate error items", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const result = schema.safeParse({ a: 1, b: "x" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = formatErrors(result.error);
      expect(errors.length).toBeGreaterThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// validate() — success path
// ---------------------------------------------------------------------------

describe("validate() — valid payloads", () => {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });
  const app = makeApp(schema);

  it("calls next() and returns 200 for a valid body", async () => {
    const res = await request(app)
      .post("/test")
      .send({ name: "Alice", age: 30 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("replaces req.body with the parsed (coerced) value", async () => {
    // Zod strips unknown keys — extra fields should not appear in req.body
    const res = await request(app)
      .post("/test")
      .send({ name: "Alice", age: 30, extra: "dropped" });

    expect(res.status).toBe(200);
    expect(res.body.body).not.toHaveProperty("extra");
  });
});

// ---------------------------------------------------------------------------
// validate() — failure path
// ---------------------------------------------------------------------------

describe("validate() — invalid payloads return 422", () => {
  const schema = z.object({
    email: z.string().email("must be a valid email"),
    amount: z.number().positive("must be positive"),
  });
  const app = makeApp(schema);

  it("returns HTTP 422 on validation failure", async () => {
    const res = await request(app)
      .post("/test")
      .send({ email: "not-an-email", amount: -5 });

    expect(res.status).toBe(422);
  });

  it("returns { errors: [{ field, message }] } shape", async () => {
    const res = await request(app)
      .post("/test")
      .send({ email: "bad", amount: 0 });

    expect(res.body).toHaveProperty("errors");
    expect(Array.isArray(res.body.errors)).toBe(true);

    const firstError = res.body.errors[0];
    expect(firstError).toHaveProperty("field");
    expect(firstError).toHaveProperty("message");
    expect(typeof firstError.field).toBe("string");
    expect(typeof firstError.message).toBe("string");
  });

  it("includes an error item for each invalid field", async () => {
    const res = await request(app)
      .post("/test")
      .send({ email: "bad", amount: -1 });

    expect(res.status).toBe(422);
    // Both email and amount are invalid, so at least 2 errors
    expect(res.body.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("returns 422 for a completely empty body", async () => {
    const res = await request(app).post("/test").send({});
    expect(res.status).toBe(422);
  });

  it("returns 422 for a missing required field", async () => {
    const res = await request(app)
      .post("/test")
      .send({ email: "a@b.com" }); // amount missing

    expect(res.status).toBe(422);
    const fields = (res.body.errors as Array<{ field: string }>).map(
      (e) => e.field
    );
    expect(fields).toContain("amount");
  });

  it("does NOT call the next handler on failure", async () => {
    const handlerSpy = jest.fn((_req: Request, res: Response) =>
      res.status(200).json({ reached: true })
    );
    const testApp = express();
    testApp.use(express.json());
    testApp.post("/spy", validate(schema), handlerSpy);

    const res = await request(testApp)
      .post("/spy")
      .send({ email: "bad", amount: -1 });

    expect(res.status).toBe(422);
    expect(handlerSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// validate() — edge cases
// ---------------------------------------------------------------------------

describe("validate() — edge cases", () => {
  it("handles a Zod transform (coercion) and passes the transformed value", async () => {
    const schema = z.object({
      count: z
        .string()
        .transform((v) => parseInt(v, 10))
        .pipe(z.number().positive()),
    });
    const app = makeApp(schema);

    const res = await request(app).post("/test").send({ count: "42" });
    expect(res.status).toBe(200);
    expect(res.body.body.count).toBe(42); // string → number via transform
  });

  it("returns 422 when body is not JSON (Content-Type missing)", async () => {
    const schema = z.object({ name: z.string() });
    const app = makeApp(schema);

    // supertest default is no body — express.json() will leave req.body as {}
    const res = await request(app).post("/test");
    expect(res.status).toBe(422);
  });

  it("does not include 'details' field in validation error response", async () => {
    const schema = z.object({ email: z.string().email() });
    const app = makeApp(schema);

    const res = await request(app)
      .post("/test")
      .send({ email: "bad" });

    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty("errors");
    expect(res.body).not.toHaveProperty("details");
  });
});
