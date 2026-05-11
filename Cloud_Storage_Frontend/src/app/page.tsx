'use client';

import Link from 'next/link';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

export default function LandingPage() {
  const features = [
    {
      icon: '🔒',
      title: 'End-to-End Encrypted',
      description: 'Your files are encrypted before they ever leave your device. Only you have the keys.',
    },
    {
      icon: '⚡',
      title: 'Lightning Fast',
      description: 'Upload and download at maximum speed with Telegram\'s global CDN network.',
    },
    {
      icon: '💾',
      title: 'Unlimited Storage',
      description: 'Store as much as you want. No hidden fees or storage limits.',
    },
    {
      icon: '🔗',
      title: 'Share Anywhere',
      description: 'Generate shareable links for any file. Control access with passwords and expiration.',
    },
    {
      icon: '📱',
      title: 'Cross-Platform',
      description: 'Access your files from any device - web, mobile, or desktop.',
    },
    {
      icon: '🛡️',
      title: 'Your Infrastructure',
      description: 'Use your own Telegram channels. Full control over your data.',
    },
  ];

  const howItWorks = [
    { step: '01', title: 'Create Account', description: 'Sign up with your Telegram account' },
    { step: '02', title: 'Connect Channel', description: 'Link your Telegram channel for storage' },
    { step: '03', title: 'Upload Files', description: 'Drag and drop files to upload' },
    { step: '04', title: 'Share Anywhere', description: 'Generate links and share securely' },
  ];

  const faqs = [
    {
      q: 'Is my data really secure?',
      a: 'Yes! Your files are encrypted before upload and stored in your own Telegram channels. Only you have access to your Telegram account and channels.',
    },
    {
      q: 'What happens if I delete my Telegram account?',
      a: 'Your files will remain in your channels, but you\'ll lose access to upload or download them. We recommend keeping your Telegram account active.',
    },
    {
      q: 'Is there a file size limit?',
      a: 'Free plan supports up to 2GB files. Pro and Enterprise plans support the same but with additional features.',
    },
    {
      q: 'Can I use my own Telegram channel?',
      a: 'Absolutely! That\'s the core feature. You connect your own Telegram channel and have full control over your storage.',
    },
    {
      q: 'Do I need Telegram Premium?',
      a: 'No, Telegram Premium is not required. The free Telegram account works perfectly with CloudStorage.',
    },
  ];

  return (
    <div className="min-h-screen bg-white dark:bg-black">
      <Header />

      {/* Hero Section */}
      <section className="pt-32 pb-20 px-4">
        <div className="max-w-7xl mx-auto text-center">
          <div className="inline-flex items-center px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-900 mb-8">
            <span className="text-sm text-gray-600 dark:text-gray-400">✨ Powered by Telegram</span>
          </div>

          <h1 className="text-5xl md:text-7xl font-bold text-black dark:text-white mb-6">
            Secure Cloud Storage
            <br />
            <span className="bg-linear-to-r from-gray-600 to-black dark:from-gray-400 dark:to-white bg-clip-text text-transparent">
              on Your Terms
            </span>
          </h1>

          <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto mb-10">
            Store your files securely using your own Telegram channels. Full control, end-to-end encryption, and unlimited storage.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/signup"
              className="px-8 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium text-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition"
            >
              Start Free Trial
            </Link>
            <a
              href="#how-it-works"
              className="px-8 py-3 border border-gray-300 dark:border-gray-700 text-black dark:text-white rounded-lg font-medium text-lg hover:bg-gray-50 dark:hover:bg-gray-900 transition"
            >
              Watch Demo
            </a>
          </div>

          <div className="mt-16 flex flex-wrap justify-center gap-8 text-sm text-gray-500 dark:text-gray-500">
            <span>✓ No file size limits</span>
            <span>✓ End-to-end encrypted</span>
            <span>✓ Your own infrastructure</span>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="py-16 border-y border-gray-200 dark:border-gray-800">
        <div className="max-w-7xl mx-auto px-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            <div>
              <div className="text-3xl font-bold text-black dark:text-white">10K+</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">Active Users</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-black dark:text-white">50TB+</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">Files Stored</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-black dark:text-white">99.9%</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">Uptime</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-black dark:text-white">24/7</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">Support</div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-20 px-4">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-black dark:text-white mb-4">Why Choose CloudStorage?</h2>
            <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
              Everything you need for secure, reliable cloud storage
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {features.map((feature, i) => (
              <div
                key={i}
                className="p-6 rounded-xl border group-hover:scale-110 border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 transition group"
              >
                <div className="text-4xl mb-4 transition-transform">{feature.icon}</div>
                <h3 className="text-xl font-semibold text-black dark:text-white mb-2">{feature.title}</h3>
                <p className="text-gray-600 dark:text-gray-400">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section id="how-it-works" className="py-20 px-4 bg-gray-50 dark:bg-gray-900/50">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-black dark:text-white mb-4">How It Works</h2>
            <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">Get started in minutes with these simple steps</p>
          </div>

          <div className="grid md:grid-cols-4 gap-8">
            {howItWorks.map((item, i) => (
              <div key={i} className="text-center group">
                <div className="w-16 h-16 mx-auto dark:text-white rounded-full border-2 border-black dark:border-white flex items-center justify-center text-2xl font-bold mb-4 group-hover:scale-110 transition">
                  {item.step}
                </div>
                <h3 className="text-lg font-semibold text-black dark:text-white mb-2">{item.title}</h3>
                <p className="text-gray-600 dark:text-gray-400 text-sm">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 bg-black dark:bg-white">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-white dark:text-black mb-4">Ready to take control of your files?</h2>
          <p className="text-xl text-gray-300 dark:text-gray-600 mb-8">
            Join thousands of users who trust CloudStorage for their file management
          </p>
          <Link
            href="/signup"
            className="inline-block px-8 py-3 bg-white dark:bg-black text-black dark:text-white rounded-lg font-medium text-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
          >
            Get Started Now
          </Link>
        </div>
      </section>

      {/* FAQ Section */}
      <section id="faq" className="py-20 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-black dark:text-white mb-4">Frequently Asked Questions</h2>
            <p className="text-xl text-gray-600 dark:text-gray-400">Got questions? We've got answers</p>
          </div>

          <div className="space-y-6">
            {faqs.map((faq, i) => (
              <div key={i} className="border-b border-gray-200 dark:border-gray-800 pb-6">
                <h3 className="text-lg font-semibold text-black dark:text-white mb-2">{faq.q}</h3>
                <p className="text-gray-600 dark:text-gray-400">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}