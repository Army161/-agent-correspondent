import { AppNav } from "@/components/shell/nav";
import { currentUser } from "@/lib/auth";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.JSX.Element> {
  const user = await currentUser();

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <AppNav userEmail={user?.email ?? null} />
      <div className="min-w-0 flex-1">
        <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10">{children}</main>
      </div>
    </div>
  );
}
