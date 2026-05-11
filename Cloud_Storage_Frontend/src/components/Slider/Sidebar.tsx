'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
    LayoutDashboard,
    FolderOpen,
    Settings,
    LogOut,
    Menu,
    X,
    Moon,
    Sun,
    ChevronLeft,
    ChevronRight,
} from 'lucide-react';

type Theme = 'dark' | 'light';

const navigation = [
    {
        name: 'Dashboard',
        href: '/dashboard',
        icon: LayoutDashboard,
    },
    {
        name: 'Files',
        href: '/dashboard/files',
        icon: FolderOpen,
    },
    {
        name: 'Settings',
        href: '/dashboard/settings',
        icon: Settings,
    },
];

interface SidebarProps {
    collapsed: boolean
    setCollapsed: (value: boolean) => void
}

export default function Sidebar({ collapsed, setCollapsed }: SidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const [mobileOpen, setMobileOpen] = useState(false);
    const [theme, setTheme] = useState<Theme>('dark');
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);

        // Get stored theme or default to 'dark'
        const stored = localStorage.getItem('theme') as Theme | null;
        const initialTheme = stored || 'dark';

        setTheme(initialTheme);

        // Apply the theme
        if (initialTheme === 'dark') {
            document.documentElement.classList.add('dark');
            document.documentElement.classList.remove('light');
        } else {
            document.documentElement.classList.remove('dark');
            document.documentElement.classList.add('light');
        }
    }, []);

    const toggleTheme = () => {
        const next = theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        localStorage.setItem('theme', next);

        // Toggle Tailwind dark class
        if (next === 'dark') {
            document.documentElement.classList.add('dark');
            document.documentElement.classList.remove('light');
        } else {
            document.documentElement.classList.remove('dark');
            document.documentElement.classList.add('light');
        }
    };

    const handleLogout = () => {
        localStorage.removeItem('theme');
        sessionStorage.removeItem('telegram_user_account');
        sessionStorage.removeItem('token');
        router.push('/');
    };

    if (!mounted) {
        return (
            <div className="fixed top-0 left-0 z-50 h-full w-65 border-r border-zinc-800 bg-zinc-950 lg:block hidden" />
        );
    }

    // Sidebar width class
    const sidebarWidth = collapsed ? 'w-[70px]' : 'w-[260px]';

    // Mobile translate class
    const mobileTranslate = mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0';

    return (
        <>
            {/* Mobile overlay */}
            {mobileOpen && (
                <div
                    className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
                    onClick={() => setMobileOpen(false)}
                />
            )}

            {/* Mobile hamburger */}
            <button
                onClick={() => setMobileOpen(true)}
                className="fixed top-4 left-4 z-50 rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-zinc-400 hover:text-white lg:hidden"
            >
                <Menu size={20} />
            </button>

            {/* Sidebar */}
            <aside
                className={`fixed top-0 left-0 z-50 flex h-full flex-col border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 transition-all duration-300 ${sidebarWidth} ${mobileTranslate}`}
            >
                {/* Logo */}
                <div className="flex h-16 items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-4">
                    {!collapsed && (
                        <Link href="/dashboard" className="flex items-center gap-3">
                            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-black dark:bg-white">
                                <FolderOpen size={18} className="text-white dark:text-black" />
                            </div>
                            <span className="text-sm font-semibold tracking-tight text-black dark:text-white">
                                CloudStorage
                            </span>
                        </Link>
                    )}
                    {collapsed && (
                        <div className="mx-auto flex h-8 w-8 items-center justify-center rounded-lg bg-black dark:bg-white">
                            <FolderOpen size={18} className="text-white dark:text-black" />
                        </div>
                    )}
                    <button
                        onClick={() => setMobileOpen(false)}
                        className="rounded p-1 text-zinc-400 hover:text-black dark:hover:text-white lg:hidden"
                    >
                        <X size={18} />
                    </button>
                </div>

                {/* Navigation */}
                <nav className="flex-1 space-y-1 px-3 py-4">
                    {navigation.map((item) => {
                        const isActive = pathname === item.href ||
                            (item.href !== '/dashboard' && pathname.startsWith(item.href));
                        const linkClass = isActive
                            ? 'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 bg-black text-white dark:bg-white dark:text-black'
                            : 'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 text-zinc-500 hover:bg-zinc-100 hover:text-black dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white';

                        return (
                            <Link
                                key={item.name}
                                href={item.href}
                                onClick={() => setMobileOpen(false)}
                                className={linkClass}
                            >
                                <item.icon size={20} />
                                {!collapsed && <span>{item.name}</span>}
                            </Link>
                        );
                    })}
                </nav>

                {/* Bottom actions */}
                <div className="border-t border-zinc-200 dark:border-zinc-800 px-3 py-4 space-y-2">
                    {/* Theme toggle */}
                    <button
                        onClick={toggleTheme}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-500 hover:bg-zinc-100 hover:text-black dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-white transition-all duration-200"
                    >
                        {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
                        {!collapsed && <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>}
                    </button>

                    {/* Logout */}
                    <button
                        onClick={handleLogout}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-red-950 dark:hover:text-red-400 transition-all duration-200"
                    >
                        <LogOut size={20} />
                        {!collapsed && <span>Logout</span>}
                    </button>
                </div>

                {/* Collapse toggle - desktop only */}
                <button
                    onClick={() => setCollapsed(!collapsed)}
                    className="cursor-pointer absolute -right-3 top-10 hidden h-6 w-6 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-400 hover:text-black dark:border-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:text-blue-600 lg:flex"
                >
                    {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
                </button>
            </aside>
        </>
    );
}