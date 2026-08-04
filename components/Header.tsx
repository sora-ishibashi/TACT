export default function Header() {
  return (
    <header className="h-16 border-b border-gray-200 flex items-center justify-between px-8">
      <h2 className="text-xl font-semibold">
        AI Workspace
      </h2>

      <div className="flex items-center gap-3">
        <div className="h-3 w-3 rounded-full bg-green-500"></div>

        <span className="text-gray-500">
          Ready
        </span>
      </div>
    </header>
  );
}