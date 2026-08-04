export default function Sidebar() {
  return (
    <aside className="w-72 border-r border-gray-200 bg-gray-50 flex flex-col">
      <div className="p-6 border-b">
        <h1 className="text-2xl font-bold">TACT</h1>
        <p className="text-sm text-gray-500 mt-1">
          AI Orchestrator
        </p>
      </div>

      <nav className="flex-1 p-4 space-y-2">
        <button className="w-full rounded-lg px-4 py-3 text-left hover:bg-white">
          🏠 Home
        </button>

        <button className="w-full rounded-lg px-4 py-3 text-left hover:bg-white">
          🤖 AI Team
        </button>

        <button className="w-full rounded-lg px-4 py-3 text-left hover:bg-white">
          📅 Calendar
        </button>

        <button className="w-full rounded-lg px-4 py-3 text-left hover:bg-white">
          ⚙️ Settings
        </button>
      </nav>
    </aside>
  );
}
