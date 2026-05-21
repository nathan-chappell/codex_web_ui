import App from "@/client/src/App";

export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  return <App initialThreadId={decodeURIComponent(threadId)} />;
}
