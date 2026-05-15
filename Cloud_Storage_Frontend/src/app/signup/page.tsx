'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import apiService from '@/services/api';
import Telegram1 from '../../../assets/Telegram1.jpg';
import Telegram2 from '../../../assets/Telegram2.jpg';
import Telegram3 from '../../../assets/Telegram3.jpg';

// ---------- Static Guide Images (moved outside component) ----------
const stepOneImages = (
  <div className="space-y-4">
    {[
      {
        src: Telegram1,
        alt: 'Step 1: Go to my.telegram.org/apps and login',
        caption: '📖 How to get your API ID & Hash — visit ',
        link: 'https://my.telegram.org/apps',
        linkText: 'my.telegram.org/apps'
      },
      {
        src: Telegram2,
        alt: 'Step 2: Create a new app or use existing one',
        caption: '📖 Step 2 — Create an app or use existing one'
      },
      {
        src: Telegram3,
        alt: 'Step 3: Copy your API ID and API Hash',
        caption: '📖 Step 3 — Copy your API ID and API Hash'
      }
    ].map(({ src, alt, caption, link, linkText }, idx) => (
      <div key={idx} className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
        <p className="text-xs text-gray-500 dark:text-gray-400 px-3 pt-2 pb-1 bg-gray-50 dark:bg-gray-900 font-medium">
          {caption}
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer" className="text-blue-500 underline ml-1">
              {linkText}
            </a>
          )}
        </p>
        <Image src={src} alt={alt} className="w-full h-auto object-contain" />
      </div>
    ))}
  </div>
);

const stepTwoImages = (
  <div className="space-y-4">
    {[
      {
        src: Telegram1,
        alt: 'Enter your phone number at my.telegram.org',
        caption: '📖 Step 1 — Enter your phone number at ',
        link: 'https://my.telegram.org',
        linkText: 'my.telegram.org'
      },
      {
        src: Telegram2,
        alt: 'Copy the confirmation code from your Telegram app',
        caption: '📖 Step 2 — Copy the confirmation code sent to your Telegram app'
      }
    ].map(({ src, alt, caption, link, linkText }, idx) => (
      <div key={idx} className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
        <p className="text-xs text-gray-500 dark:text-gray-400 px-3 pt-2 pb-1 bg-gray-50 dark:bg-gray-900 font-medium">
          {caption}
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer" className="text-blue-500 underline ml-1">
              {linkText}
            </a>
          )}
        </p>
        <Image src={src} alt={alt} className="w-full h-auto object-contain" />
      </div>
    ))}
  </div>
);

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
  const [twoFAPassword, setTwoFAPassword] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    const userData = sessionStorage.getItem('telegram_user_account');
    if (userData) {
      router.push('/dashboard');
    }
  }, [router]);

  const handleSendCode = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    let abort = false;
    try {
      const response = await apiService.sendCode(phoneNumber, parseInt(apiId), apiHash);
      if (abort) return;
      if (response.success) setStep(2);
    } catch (err: any) {
      if (abort) return;
      setError(err.response?.data?.error || err.message || 'Failed to send verification code');
    } finally {
      if (!abort) setLoading(false);
    }
    return () => { abort = true; };
  }, [phoneNumber, apiId, apiHash]);

  const handleVerifyCode = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(''); 
    console.log('2FA password received:', JSON.stringify(twoFAPassword));
    console.log('2FA password type:', typeof twoFAPassword);
    console.log('2FA password length:', twoFAPassword?.length);
    let abort = false;
    try {
      const isId = channelUsername.startsWith('-') || /^\d+$/.test(channelUsername.trim());

      const response = await apiService.verifyCode(
        phoneNumber,
        parseInt(verificationCode),
        (!channelUsername || isId) ? undefined : channelUsername,  // groupUsername
        (channelUsername && isId) ? channelUsername : undefined,   // groupId
        twoFAPassword || undefined,
      );
      if (abort) return;
      if (response.success) {
        apiService.setToken(response.token);
        sessionStorage.setItem('temp_token', response.token);
        sessionStorage.setItem('telegram_user_account', JSON.stringify(response.user));
        setStep(3);
      }
    } catch (err: any) {
      if (abort) return;
      setError(err.response?.data?.error || err.message || 'Verification failed');
    } finally {
      if (!abort) setLoading(false);
    }
    return () => { abort = true; };
  }, [phoneNumber, verificationCode, channelUsername, twoFAPassword]);

  const handleCompleteProfile = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return; }
    setLoading(true);
    setError('');
    let abort = false;
    try {
      const response = await apiService.completeProfile(email, password);
      if (abort) return;
      if (response.success) router.push('/dashboard');
    } catch (err: any) {
      if (abort) return;
      setError(err.response?.data?.error || err.message || 'Profile completion failed');
    } finally {
      if (!abort) setLoading(false);
    }
    return () => { abort = true; };
  }, [email, password, confirmPassword, router]);

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
            {stepOneImages}

            <div>
              <label className="block text-sm font-medium text-black dark:text-white mb-2">
                Telegram Phone Number
              </label>
              <input
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                autoComplete="tel"
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white text-sm"
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
                autoComplete="off"
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white text-sm"
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
                autoComplete="off"
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white text-sm"
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
                autoComplete="off"
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white text-sm"
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
              className="w-full py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-gray-800 dark:hover:bg-gray-200 transition disabled:opacity-50 text-sm"
            >
              {loading ? 'Sending Code...' : 'Send Verification Code'}
            </button>
          </form>
        )}

        {/* STEP 2 */}
        {step === 2 && (
          <form onSubmit={handleVerifyCode} className="space-y-6">
            {stepTwoImages}

            <div>
              <label className="block text-sm font-medium text-black dark:text-white mb-2">
                Verification Code
              </label>
              <input
                type="text"
                value={verificationCode}
                onChange={(e) => setVerificationCode(e.target.value)}
                autoComplete="one-time-code"
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white text-sm"
                placeholder="Enter 5-digit code"
                required
              />
              <p className="mt-1 text-xs text-gray-500">Check your Telegram app for the code</p>
            </div>

            {/* ADD THIS NEW FIELD */}
            <div>
              <label className="block text-sm font-medium text-black dark:text-white mb-2">
                2FA Password (if enabled)
              </label>
              <input
                type="password"
                value={twoFAPassword}
                onChange={(e) => setTwoFAPassword(e.target.value)}
                autoComplete="off"
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white text-sm"
                placeholder="Leave empty if not set"
              />
              <p className="mt-1 text-xs text-gray-500">Only needed if you have 2-step verification enabled</p>
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
                className="flex-1 py-3 border border-gray-300 dark:border-gray-700 text-black dark:text-white rounded-lg font-medium hover:bg-gray-50 dark:hover:bg-gray-900 transition text-sm"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-gray-800 dark:hover:bg-gray-200 transition disabled:opacity-50 text-sm"
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
                autoComplete="email"
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white text-sm"
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
                autoComplete="new-password"
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white text-sm"
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
                autoComplete="new-password"
                className="w-full px-4 py-3 bg-white dark:bg-black border border-gray-300 dark:border-gray-700 rounded-lg text-black dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black dark:focus:ring-white text-sm"
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
              className="w-full py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-gray-800 dark:hover:bg-gray-200 transition disabled:opacity-50 text-sm"
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