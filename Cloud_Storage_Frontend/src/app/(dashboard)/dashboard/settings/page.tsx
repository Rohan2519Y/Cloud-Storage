'use client'

import { useRouter } from 'next/navigation'

export default function SettingsPage() {
    const router = useRouter()

    return (
        <div className="p-6 lg:p-10 max-w-2xl">
            <h1 className="text-3xl font-bold text-black dark:text-white mb-8">Settings</h1>

            <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-6">
                <h2 className="text-lg font-semibold text-black dark:text-white mb-1">Telegram Connection</h2>
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
                    If uploads, downloads, or previews start failing, your Telegram session may
                    have been revoked (e.g. if you removed it or changed your 2FA password on
                    Telegram's side). Reconnecting asks for a fresh code and, if needed, your
                    current 2FA password.
                </p>
                <button
                    onClick={() => router.push('/reconnect-telegram')}
                    className="cursor-pointer inline-flex items-center gap-2 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
                >
                    Reconnect Telegram
                </button>
            </div>
        </div>
    )
}
