import { DemoChat } from "@/components/DemoChat";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 lg:p-24 relative overflow-hidden">
      {/* Background ambient glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-blue-600/20 rounded-full blur-[120px] pointer-events-none" />

      <div className="z-10 w-full max-w-7xl mx-auto flex flex-col items-center gap-8">
        <div className="w-full relative group">
          <DemoChat />
        </div>
      </div>
    </main>
  );
}
