import { NextRequest } from 'next/server';
import { middleware, config } from './middleware';

// Mock NextResponse
jest.mock('next/server', () => ({
  NextResponse: {
    redirect: jest.fn((url) => ({
      status: 307,
      headers: new Headers({ location: url.toString() }),
    })),
    next: jest.fn(() => ({ status: 200, headers: new Headers() })),
    rewrite: jest.fn((url) => ({ status: 200, headers: new Headers() })),
  },
}));

// Mock next-intl middleware — return a passthrough so auth behaviour is tested
// in isolation.
jest.mock('next-intl/middleware', () => ({
  __esModule: true,
  default: jest.fn(() => () => ({ status: 200, headers: new Headers() })),
}));

// next-intl/routing ships ESM-only; stub it so the middleware's routing config
// can be imported under Jest without transforming node_modules.
jest.mock('next-intl/routing', () => ({
  defineRouting: (config: any) => config,
}));

describe('Middleware Matcher', () => {
  it('should match all routes except internal Next.js and static assets', () => {
    expect(config.matcher).toEqual(['/((?!api|_next|.*\\..*).*)']);
  });
});

describe('Middleware JWT Validation', () => {
  let mockRequest: any;

  beforeEach(() => {
    mockRequest = {
      nextUrl: {
        pathname: '/wallet',
      },
      cookies: {
        get: jest.fn(),
      },
      headers: new Headers(),
      url: 'http://localhost:3000',
    };
  });

  it('should redirect to signup when no token is present', () => {
    mockRequest.cookies.get.mockReturnValue(undefined);

    const result = middleware(mockRequest as NextRequest);

    expect(result.status).toBe(307);
    const location = result.headers.get('location');
    expect(location).toContain('/auth/signup');
    expect(location).toContain('redirect=%2Fwallet');
  });

  it('should redirect to signup when token is invalid', () => {
    mockRequest.cookies.get.mockReturnValue({ value: 'invalid.token.here' });

    const result = middleware(mockRequest as NextRequest);

    expect(result.status).toBe(307);
    const location = result.headers.get('location');
    expect(location).toContain('/auth/signup');
  });

  it('should allow valid tokens through to the i18n middleware', () => {
    const payload = { userId: 'user123', exp: Math.floor(Date.now() / 1000) + 3600 };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `header.${encodedPayload}.signature`;

    mockRequest.cookies.get.mockReturnValue({ value: token });

    const result = middleware(mockRequest as NextRequest);

    expect(result.status).toBe(200);
  });

  it('should redirect non-admin users from admin routes', () => {
    const payload = { userId: 'user123', role: 'user', exp: Math.floor(Date.now() / 1000) + 3600 };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `header.${encodedPayload}.signature`;

    mockRequest.cookies.get.mockReturnValue({ value: token });
    mockRequest.nextUrl.pathname = '/admin/dashboard';

    const result = middleware(mockRequest as NextRequest);

    expect(result.status).toBe(307);
    const location = result.headers.get('location');
    expect(location).toContain('/');
  });

  it('should allow admin users to access admin routes', () => {
    const payload = { userId: 'admin123', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `header.${encodedPayload}.signature`;

    mockRequest.cookies.get.mockReturnValue({ value: token });
    mockRequest.nextUrl.pathname = '/admin/dashboard';

    const result = middleware(mockRequest as NextRequest);

    expect(result.status).toBe(200);
  });

  it('should read from session cookie if Authorization cookie is missing', () => {
    const payload = { userId: 'user123', exp: Math.floor(Date.now() / 1000) + 3600 };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `header.${encodedPayload}.signature`;

    mockRequest.cookies.get.mockImplementation((name: string) => {
      if (name === 'Authorization') return undefined;
      if (name === 'session') return { value: token };
      return undefined;
    });

    const result = middleware(mockRequest as NextRequest);

    expect(result.status).toBe(200);
  });

  it('should redirect for expired tokens', () => {
    const payload = { userId: 'user123', exp: Math.floor(Date.now() / 1000) - 3600 };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `header.${encodedPayload}.signature`;

    mockRequest.cookies.get.mockReturnValue({ value: token });

    const result = middleware(mockRequest as NextRequest);

    expect(result.status).toBe(307);
    const location = result.headers.get('location');
    expect(location).toContain('/auth/signup');
  });

  it('should protect locale-prefixed routes', () => {
    mockRequest.cookies.get.mockReturnValue(undefined);
    mockRequest.nextUrl.pathname = '/yo/wallet';

    const result = middleware(mockRequest as NextRequest);

    expect(result.status).toBe(307);
    const location = result.headers.get('location');
    expect(location).toContain('/auth/signup');
    expect(location).toContain('redirect=%2Fwallet');
  });
});
