import { apiFetch } from "./apiFetch";
import { getToken } from "../app/lib/auth";

jest.mock("../app/lib/auth", () => ({
  getToken: jest.fn(),
}));

describe("apiFetch authentication", () => {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("attaches the bearer token when one is available", async () => {
    jest.mocked(getToken).mockReturnValue("test-token");

    await apiFetch("/api/v1/profile");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3001/api/v1/profile",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      }),
    );
  });

  it("omits the Authorization header when no token is available", async () => {
    jest.mocked(getToken).mockReturnValue(null);

    await apiFetch("/api/v1/profile");

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(options.headers).not.toHaveProperty("Authorization");
  });
});
