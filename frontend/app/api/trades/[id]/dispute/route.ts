import { NextRequest, NextResponse } from "next/server";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL || "http://localhost:3001";

  try {
    const body = await req.json().catch(() => ({}));
    const authHeader = req.headers.get("authorization");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authHeader) {
      headers["authorization"] = authHeader;
    }

    const backendRes = await fetch(`${apiUrl}/api/v1/trades/${encodeURIComponent(id)}/dispute`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const data = await backendRes.json().catch(() => ({}));
    return NextResponse.json(data, { status: backendRes.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Internal server error connecting to trade dispute service" },
      { status: 500 }
    );
  }
}
