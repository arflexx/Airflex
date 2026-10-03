import { NextResponse } from "next/server";

/** Accept CSP reports without echoing request contents into the response. */
export async function POST() {
  return new NextResponse(null, { status: 204 });
}
