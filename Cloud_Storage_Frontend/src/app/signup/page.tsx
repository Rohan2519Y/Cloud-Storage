'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import apiService from '@/services/api';
import Image from 'next/image';
import Telegram1 from '../../../assets/Telegram1.jpg';
import Telegram2 from '../../../assets/Telegram2.jpg';
import Telegram3 from '../../../assets/Telegram3.jpg';

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  
  const [phoneNumber, setPhoneNumber] = useState('');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [channelUsername, setChannelUsername] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    const token = apiService.getToken();
    if (token) {
      router.push('/dashboard');
    }
  }, [router]);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await apiService.sendCode(phoneNumber, parseInt(apiId), apiHash);
      if (response.success) setStep(2);
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to send verification code');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await apiService.verifyCode(
        phoneNumber,
        parseInt(verificationCode),
        channelUsername || undefined,
        undefined
      );
      if (response.success) {
        apiService.setToken(response.token);
        sessionStorage.setItem('temp_token', response.token);
        sessionStorage.setItem('user', JSON.stringify(response.user));
        setStep(3);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    setLoading(true);
    setError('');
    try {
      const response = await apiService.completeProfile(email, password);
      if (response.success) router.push('/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Profile completion failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-white dark:bg-black py-12">
      <div className="max-w-md w-full mx-4">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-black dark:text-white mb-2">Create Account</h1>
          <p className="text-gray-600 dark:text-gray-400">
            {step === 1 && 'Connect your Telegram account'}
            {step === 2 && 'Verify your phone number'}
            {step === 3 && 'Complete your profile'}
          </p>
        </div>

        {/* STEP 1 */}
        {step === 1 && (
          <form onSubmit={handleSendCode} className="space-y-6">
            {/* Guide images for API ID & Hash */}
            <div className="space-y-4">
              <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 dark:text-gray-400 px-3 pt-2 pb-1 bg-gray-50 dark:bg-gray-900 font-medium">
                  📖 How to get your API ID & Hash — visit{' '}
                  <a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer" className="text-blue-500 underline">
                    my.telegram.org/apps
                  </a>
                </p>
                <Image
                  src={Telegram1}
                  alt="Step 1: Go to my.telegram.org/apps and login"
                  className="w-full h-auto object-contain"
                  priority
                />
              </div>

              <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 dark:text-gray-400 px-3 pt-2 pb-1 bg-gray-50 dark:bg-gray-900 font-medium">
                  📖 Step 2 — Create an app or use existing one
                </p>
                <Image
                  src={Telegram2}
                  alt="Step 2: Create a new app or use existing one"
                  className="w-full h-auto object-contain"
                />
              </div>

              <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 dark:text-gray-400 px-3 pt-2 pb-1 bg-gray-50 dark:bg-gray-900 font-medium">
                  📖 Step 3 — Copy your API ID and API Hash
                </p>
                <Image
                  src={Telegram3}
                  alt="Step 3: Copy your API ID and API Hash"
                  className="w-full h-auto object-contain rounded-b-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-black dark:text-white mb-2">
                Telegram Phone Number
              </label>
              <input
                type="text"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white"
                placeholder="+1234567890"
                required
              />
              <p className="mt-1 text-xs text-gray-500">Include country code (e.g., +91 for India)</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-black dark:text-white mb-2">
                Telegram API ID
              </label>
              <input
                type="text"
                value={apiId}
                onChange={(e) => setApiId(e.target.value)}
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white"
                placeholder="Get from my.telegram.org/apps"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-black dark:text-white mb-2">
                Telegram API Hash
              </label>
              <input
                type="text"
                value={apiHash}
                onChange={(e) => setApiHash(e.target.value)}
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white"
                placeholder="32-character hash"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-black dark:text-white mb-2">
                Channel Username (Optional)
              </label>
              <input
                type="text"
                value={channelUsername}
                onChange={(e) => setChannelUsername(e.target.value)}
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white"
                placeholder="@yourchannel"
              />
              <p className="mt-1 text-xs text-gray-500">Your channel where files will be stored</p>
            </div>

            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-red-600 dark:text-red-400 text-sm text-center">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-gray-800 dark:hover:bg-gray-200 transition disabled:opacity-50"
            >
              {loading ? 'Sending Code...' : 'Send Verification Code'}
            </button>
          </form>
        )}

        {/* STEP 2 */}
        {step === 2 && (
          <form onSubmit={handleVerifyCode} className="space-y-6">
            {/* Guide images for phone number entry + confirmation code */}
            <div className="space-y-4">
              <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 dark:text-gray-400 px-3 pt-2 pb-1 bg-gray-50 dark:bg-gray-900 font-medium">
                  📖 Step 1 — Enter your phone number at{' '}
                  <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="text-blue-500 underline">
                    my.telegram.org
                  </a>
                </p>
                <Image
                  src={Telegram1}
                  alt="Enter your phone number in international format on my.telegram.org"
                  className="w-full h-auto object-contain"
                />
              </div>

              <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-500 dark:text-gray-400 px-3 pt-2 pb-1 bg-gray-50 dark:bg-gray-900 font-medium">
                  📖 Step 2 — Copy the confirmation code sent to your Telegram app
                </p>
                <Image
                  src={Telegram2}
                  alt="Copy the confirmation code from your Telegram app and enter it"
                  className="w-full h-auto object-contain"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-black dark:text-white mb-2">
                Verification Code
              </label>
              <input
                type="text"
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value)}
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white"
                placeholder="Enter 5-digit code"
                required
              />
              <p className="mt-1 text-xs text-gray-500">Check your Telegram app for the code</p>
            </div>

            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-red-600 dark:text-red-400 text-sm text-center">{error}</p>
              </div>
            )}

            <div className="flex gap-4">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="flex-1 py-3 border border-gray-300 dark:border-gray-700 text-black dark:text-white rounded-lg font-medium hover:bg-gray-50 dark:hover:bg-gray-900 transition"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-gray-800 dark:hover:bg-gray-200 transition disabled:opacity-50"
              >
                {loading ? 'Verifying...' : 'Verify & Continue'}
              </button>
            </div>
          </form>
        )}

        {/* STEP 3 */}
        {step === 3 && (
          <form onSubmit={handleCompleteProfile} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-black dark:text-white mb-2">
                Email Address
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white"
                placeholder="you@example.com"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-black dark:text-white mb-2">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white"
                placeholder="Minimum 6 characters"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-black dark:text-white mb-2">
                Confirm Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white"
                placeholder="Confirm your password"
                required
              />
            </div>

            {error && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-red-600 dark:text-red-400 text-sm text-center">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-gray-800 dark:hover:bg-gray-200 transition disabled:opacity-50"
            >
              {loading ? 'Creating Account...' : 'Complete Sign Up'}
            </button>
          </form>
        )}

        <div className="mt-6 text-center">
          <p className="text-gray-600 dark:text-gray-400">
            Already have an account?{' '}
            <Link href="/login" className="text-black dark:text-white font-medium hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}