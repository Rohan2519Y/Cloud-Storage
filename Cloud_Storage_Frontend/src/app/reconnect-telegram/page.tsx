'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import apiService from '@/services/api';

export default function ReconnectTelegramPage() {
  const router = useRouter();
  const [step, setStep] = useState<'sending' | 'code' | 'password'>('sending');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const sendCode = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      await apiService.reconnectTelegramSendCode();
      setStep('code');
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to send verification code');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    sendCode();
  }, [sendCode]);

  const handleVerify = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await apiService.reconnectTelegramVerify(
        step === 'code' ? code : undefined,
        step === 'password' ? password : undefined,
      );
      if (response.success) {
        router.push('/dashboard');
        return;
      }
    } catch (err: any) {
      const data = err.response?.data;
      if (data?.requirePassword || data?.invalidPassword) {
        setStep('password');
      }
      setError(data?.error || err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  }, [step, code, password, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-white dark:bg-black px-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-black dark:text-white mb-2">Reconnect Telegram</h1>
          <p className="text-gray-600 dark:text-gray-400 text-sm">
            {step === 'sending' && 'Sending a verification code to your Telegram account...'}
            {step === 'code' && 'Your Telegram session needs to be refreshed. Enter the code we just sent you.'}
            {step === 'password' && 'Enter your current Telegram 2-Step Verification password.'}
          </p>
        </div>

        {step !== 'sending' && (
          <form onSubmit={handleVerify} className="space-y-6">
            {step === 'code' && (
              <div>
                <label className="block text-sm font-medium text-black dark:text-white mb-2">
                  Verification Code
                </label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  autoFocus
                  className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white text-sm"
                  placeholder="Enter the code sent to Telegram"
                  required
                />
              </div>
            )}

            {step === 'password' && (
              <div>
                <label className="block text-sm font-medium text-black dark:text-white mb-2">
                  2FA Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                  autoFocus
                  className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white text-sm"
                  placeholder="Your current Telegram 2FA password"
                  required
                />
              </div>
            )}

            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-red-600 dark:text-red-400 text-sm text-center">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="cursor-pointer w-full py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-gray-800 dark:hover:bg-gray-200 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Verifying...' : 'Continue'}
            </button>
          </form>
        )}

        {step === 'sending' && error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-red-600 dark:text-red-400 text-sm text-center">{error}</p>
            <button
              onClick={sendCode}
              className="mt-3 w-full text-sm font-medium text-black dark:text-white hover:underline"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
