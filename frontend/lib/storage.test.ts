import { saveTheme, loadTheme, clearTheme } from "./storage";

/**
 * Theme persistence (issue #605).
 *
 * `storage.ts`'s `isLocalStorageAvailable` probe writes/removes a throwaway
 * key on `window.localStorage` before each real read/write, so these tests
 * mock `window.localStorage` directly rather than relying on jsdom's default
 * implementation — this lets us assert the exact calls made and simulate
 * storage failures (quota exceeded / private browsing).
 */
describe("storage.ts theme helpers", () => {
  let store: Record<string, string>;
  let mockLocalStorage: {
    getItem: jest.Mock;
    setItem: jest.Mock;
    removeItem: jest.Mock;
  };

  beforeEach(() => {
    store = {};
    mockLocalStorage = {
      getItem: jest.fn((key: string) => (key in store ? store[key] : null)),
      setItem: jest.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: jest.fn((key: string) => {
        delete store[key];
      }),
    };
    Object.defineProperty(window, "localStorage", {
      value: mockLocalStorage,
      writable: true,
    });
  });

  it("saveTheme persists the preference under the airflex-theme key", () => {
    saveTheme("dark");
    expect(mockLocalStorage.setItem).toHaveBeenCalledWith("airflex-theme", "dark");
    expect(store["airflex-theme"]).toBe("dark");
  });

  it("loadTheme retrieves a previously saved preference", () => {
    saveTheme("light");
    expect(loadTheme()).toBe("light");
  });

  it("loadTheme returns null when nothing has been saved", () => {
    expect(loadTheme()).toBeNull();
  });

  it("clearTheme removes the saved preference", () => {
    saveTheme("dark");
    expect(loadTheme()).toBe("dark");

    const result = clearTheme();

    expect(result).toBe(true);
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith("airflex-theme");
    expect(loadTheme()).toBeNull();
  });

  it("saveTheme fails silently when localStorage throws (e.g. quota exceeded)", () => {
    // Let the internal "is storage available" probe (a throwaway __test__
    // key) succeed, but fail the real write so the inner try/catch in
    // `saveTheme` itself is what's under test.
    mockLocalStorage.setItem.mockImplementation((key: string, value: string) => {
      if (key === "airflex-theme") throw new Error("QuotaExceededError");
      store[key] = value;
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => saveTheme("dark")).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    expect(store["airflex-theme"]).toBeUndefined();

    warnSpy.mockRestore();
  });

  it("loadTheme returns null when localStorage throws", () => {
    mockLocalStorage.getItem.mockImplementation((key: string) => {
      if (key === "airflex-theme") throw new Error("SecurityError");
      return key in store ? store[key] : null;
    });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    expect(loadTheme()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
