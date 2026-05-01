"use client";
import Link from "next/link";

import { ModeToggle } from "./mode-toggle";

export default function Header() {
  const links = [
    { to: "/",          label: "Runs" },
    { to: "/runs/new",  label: "New run" },
    { to: "/compare",   label: "Compare" },
  ] as const;

  return (
    <div>
      <div className="flex flex-row items-center justify-between px-3 py-2">
        <nav className="flex gap-4 text-sm">
          <span className="font-semibold">HEALOSBENCH</span>
          {links.map(({ to, label }) => (
            <Link key={to} href={to} className="opacity-80 hover:opacity-100">
              {label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ModeToggle />
        </div>
      </div>
      <hr />
    </div>
  );
}
