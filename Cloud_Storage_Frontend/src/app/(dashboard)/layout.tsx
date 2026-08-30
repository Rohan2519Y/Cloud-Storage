'use client'
import Sidebar from "@/components/Slider/Sidebar"
import { Bell, Search } from "lucide-react"
import { useState, useEffect } from "react";

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const [collapsed, setCollapsed] = useState<boolean>(false);
    const [user, setUser] = useState<any>(null);

    useEffect(() => {
        const userData = sessionStorage.getItem('telegram_user_account');
        if (userData) {
            setUser(JSON.parse(userData));
        }
    }, []);

    return (
        <div className="flex min-h-screen bg-white dark:bg-black">
            <Sidebar collapsed={collapsed} setCollapsed={setCollapsed} />

            <div className={`flex-1 min-w-0 transition-all duration-300 ${collapsed ? 'lg:ml-[70px]' : 'lg:ml-[260px]'}`}>
                {/* Header */}
                <header className="sticky top-0 z-30 border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-black/80 backdrop-blur-sm">
                    <div className="flex h-16 items-center justify-end px-6 lg:px-10">

                        <div className="flex items-center gap-4">

                            <div className="flex items-center gap-3">
                                <div className="h-8 w-8 rounded-full bg-black dark:bg-white flex items-center justify-center text-xs font-semibold text-white dark:text-black">
                                    {user?.firstName?.charAt(0)?.toUpperCase() || 'U'}
                                </div>
                                <div className="hidden sm:block">
                                    <p className="text-sm font-medium text-black dark:text-white">
                                        {user?.firstName || 'User'} {user?.lastName || ''}
                                    </p>
                                    <p className="text-xs text-zinc-500">
                                        {user?.email || user?.phoneNumber || ''}
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>
                </header>
                {children}
            </div>
        </div>
    );
}