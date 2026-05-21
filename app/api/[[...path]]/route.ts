import { handleApiRequest } from "@/server/appApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleApiRequest(request);
}

export function HEAD(request: Request) {
  return handleApiRequest(request);
}

export function POST(request: Request) {
  return handleApiRequest(request);
}

export function DELETE(request: Request) {
  return handleApiRequest(request);
}

export function OPTIONS(request: Request) {
  return handleApiRequest(request);
}
