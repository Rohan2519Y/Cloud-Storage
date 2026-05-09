'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div className="min-h-screen bg-white dark:bg-black">
      {/* Navigation */}
      <nav className={`fixed top-0 w-full z-50 transition-all duration-300 ${
        scrolled ? 'bg-white/90 dark:bg-black/90 backdrop-blur-md border-b border-gray-200 dark:border-gray-800' : 'bg-transparent'
      }`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-2">
              <span className="text-2xl">📁</span>
              <span className="font-bold text-xl text-black dark:text-white">CloudStorage</span>
            </div>
            
            <div className="hidden md:flex items-center space-x-8">
              <a href="#features" className="text-gray-600 dark:text-gray-300 hover:text-black dark:hover:text-white transition">Features</a>
              <a href="#how-it-works" className="text-gray-600 dark:text-gray-300 hover:text-black dark:hover:text-white transition">How it Works</a>
              <a href="#pricing" className="text-gray-600 dark:text-gray-300 hover:text-black dark:hover:text-white transition">Pricing</a>
              <a href="#faq" className="text-gray-600 dark:text-gray-300 hover:text-black dark:hover:text-white transition">FAQ</a>
            </div>
            
            <div className="flex items-center space-x-4">
              <Link href="/login" className="px-4 py-2 text-black dark:text-white hover:underline transition">
                Sign In
              </Link>
              <Link href="/signup" className="px-4 py-2 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium hover:bg-gray-800 dark:hover:bg-gray-200 transition">
                Get Started
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="pt-32 pb-20 px-4">
        <div className="max-w-7xl mx-auto text-center">
          <div className="inline-flex items-center px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-900 mb-8">
            <span className="text-sm text-gray-600 dark:text-gray-400">✨ Powered by Telegram</span>
          </div>
          
          <h1 className="text-5xl md:text-7xl font-bold text-black dark:text-white mb-6">
            Secure Cloud Storage
            <br />
            <span className="bg-gradient-to-r from-gray-600 to-black dark:from-gray-400 dark:to-white bg-clip-text text-transparent">
              on Your Terms
            </span>
          </h1>
          
          <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto mb-10">
            Store your files securely using your own Telegram channels. 
            Full control, end-to-end encryption, and unlimited storage.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/signup" className="px-8 py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg font-medium text-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition">
              Start Free Trial
            </Link>
            <a href="#how-it-works" className="px-8 py-3 border border-gray-300 dark:border-gray-700 text-black dark:text-white rounded-lg font-medium text-lg hover:bg-gray-50 dark:hover:bg-gray-900 transition">
              Watch Demo
            </a>
          </div>
          
          <div className="mt-16 flex justify-center gap-8 text-sm text-gray-500 dark:text-gray-500">
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
            <h2 className="text-3xl md:text-4xl font-bold text-black dark:text-white mb-4">
              Why Choose CloudStorage?
            </h2>
            <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
              Everything you need for secure, reliable cloud storage
            </p>
          </div>
          
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: "🔒",
                title: "End-to-End Encrypted",
                description: "Your files are encrypted before they ever leave your device. Only you have the keys."
              },
              {
                icon: "⚡",
                title: "Lightning Fast",
                description: "Upload and download at maximum speed with Telegram's global CDN network."
              },
              {
                icon: "💾",
                title: "Unlimited Storage",
                description: "Store as much as you want. No hidden fees or storage limits."
              },
              {
                icon: "🔗",
                title: "Share Anywhere",
                description: "Generate shareable links for any file. Control access with passwords and expiration."
              },
              {
                icon: "📱",
                title: "Cross-Platform",
                description: "Access your files from any device - web, mobile, or desktop."
              },
              {
                icon: "🛡️",
                title: "Your Infrastructure",
                description: "Use your own Telegram channels. Full control over your data."
              }
            ].map((feature, i) => (
              <div key={i} className="p-6 rounded-xl border border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 transition">
                <div className="text-4xl mb-4">{feature.icon}</div>
                <h3 className="text-xl font-semibold text-black dark:text-white mb-2">{feature.title}</h3>
                <p className="text-gray-600 dark:text-gray-400">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-20 px-4 bg-gray-50 dark:bg-gray-900/50">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-black dark:text-white mb-4">
              How It Works
            </h2>
            <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
              Get started in minutes with these simple steps
            </p>
          </div>
          
          <div className="grid md:grid-cols-4 gap-8">
            {[
              { step: "01", title: "Create Account", description: "Sign up with your Telegram account" },
              { step: "02", title: "Connect Channel", description: "Link your Telegram channel for storage" },
              { step: "03", title: "Upload Files", description: "Drag and drop files to upload" },
              { step: "04", title: "Share Anywhere", description: "Generate links and share securely" }
            ].map((item, i) => (
              <div key={i} className="text-center">
                <div className="w-16 h-16 mx-auto rounded-full border-2 border-black dark:border-white flex items-center justify-center text-2xl font-bold mb-4">
                  {item.step}
                </div>
                <h3 className="text-lg font-semibold text-black dark:text-white mb-2">{item.title}</h3>
                <p className="text-gray-600 dark:text-gray-400 text-sm">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-20 px-4">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-black dark:text-white mb-4">
              Simple, Transparent Pricing
            </h2>
            <p className="text-xl text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
              Choose the plan that works for you
            </p>
          </div>
          
          <div className="grid md:grid-cols-3 gap-8">
            {/* Free Plan */}
            <div className="p-8 rounded-xl border border-gray-200 dark:border-gray-800 hover:shadow-lg transition">
              <h3 className="text-2xl font-bold text-black dark:text-white mb-2">Free</h3>
              <div className="text-4xl font-bold text-black dark:text-white mb-4">$0</div>
              <p className="text-gray-600 dark:text-gray-400 mb-6">Perfect for personal use</p>
              <ul className="space-y-3 mb-8">
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ Up to 2GB files</li>
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ Basic sharing</li>
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ 1 channel connection</li>
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ 7-day file history</li>
              </ul>
              <Link href="/signup" className="block text-center py-3 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-900 transition">
                Get Started
              </Link>
            </div>
            
            {/* Pro Plan */}
            <div className="p-8 rounded-xl border-2 border-black dark:border-white shadow-lg">
              <h3 className="text-2xl font-bold text-black dark:text-white mb-2">Pro</h3>
              <div className="text-4xl font-bold text-black dark:text-white mb-2">$9<span className="text-lg">/mo</span></div>
              <p className="text-gray-600 dark:text-gray-400 mb-6">Best for professionals</p>
              <ul className="space-y-3 mb-8">
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ Up to 2GB files</li>
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ Advanced sharing</li>
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ Unlimited channels</li>
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ 30-day file history</li>
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ Priority support</li>
              </ul>
              <Link href="/signup" className="block text-center py-3 bg-black dark:bg-white text-white dark:text-black rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition">
                Start Pro Trial
              </Link>
            </div>
            
            {/* Enterprise Plan */}
            <div className="p-8 rounded-xl border border-gray-200 dark:border-gray-800 hover:shadow-lg transition">
              <h3 className="text-2xl font-bold text-black dark:text-white mb-2">Enterprise</h3>
              <div className="text-4xl font-bold text-black dark:text-white mb-2">Custom</div>
              <p className="text-gray-600 dark:text-gray-400 mb-6">For large organizations</p>
              <ul className="space-y-3 mb-8">
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ Unlimited file size</li>
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ Custom integrations</li>
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ Dedicated support</li>
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ SLA guarantee</li>
                <li className="text-sm text-gray-600 dark:text-gray-400">✓ SSO & compliance</li>
              </ul>
              <Link href="/contact" className="block text-center py-3 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-900 transition">
                Contact Sales
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 bg-black dark:bg-white">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-white dark:text-black mb-4">
            Ready to take control of your files?
          </h2>
          <p className="text-xl text-gray-300 dark:text-gray-600 mb-8">
            Join thousands of users who trust CloudStorage for their file management
          </p>
          <Link href="/signup" className="inline-block px-8 py-3 bg-white dark:bg-black text-black dark:text-white rounded-lg font-medium text-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition">
            Get Started Now
          </Link>
        </div>
      </section>

      {/* FAQ Section */}
      <section id="faq" className="py-20 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-black dark:text-white mb-4">
              Frequently Asked Questions
            </h2>
            <p className="text-xl text-gray-600 dark:text-gray-400">
              Got questions? We've got answers
            </p>
          </div>
          
          <div className="space-y-6">
            {[
              {
                q: "Is my data really secure?",
                a: "Yes! Your files are encrypted before upload and stored in your own Telegram channels. Only you have access to your Telegram account and channels."
              },
              {
                q: "What happens if I delete my Telegram account?",
                a: "Your files will remain in your channels, but you'll lose access to upload or download them. We recommend keeping your Telegram account active."
              },
              {
                q: "Is there a file size limit?",
                a: "Free plan supports up to 2GB files. Pro and Enterprise plans support the same but with additional features."
              },
              {
                q: "Can I use my own Telegram channel?",
                a: "Absolutely! That's the core feature. You connect your own Telegram channel and have full control over your storage."
              },
              {
                q: "Do I need Telegram Premium?",
                a: "No, Telegram Premium is not required. The free Telegram account works perfectly with CloudStorage."
              }
            ].map((faq, i) => (
              <div key={i} className="border-b border-gray-200 dark:border-gray-800 pb-6">
                <h3 className="text-lg font-semibold text-black dark:text-white mb-2">{faq.q}</h3>
                <p className="text-gray-600 dark:text-gray-400">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-4 border-t border-gray-200 dark:border-gray-800">
        <div className="max-w-7xl mx-auto">
          <div className="grid md:grid-cols-4 gap-8 mb-8">
            <div>
              <div className="flex items-center space-x-2 mb-4">
                <span className="text-2xl">📁</span>
                <span className="font-bold text-black dark:text-white">CloudStorage</span>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Secure cloud storage powered by Telegram
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-black dark:text-white mb-4">Product</h4>
              <ul className="space-y-2 text-sm text-gray-500 dark:text-gray-400">
                <li><a href="#features" className="hover:text-black dark:hover:text-white">Features</a></li>
                <li><a href="#pricing" className="hover:text-black dark:hover:text-white">Pricing</a></li>
                <li><a href="#faq" className="hover:text-black dark:hover:text-white">FAQ</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-black dark:text-white mb-4">Company</h4>
              <ul className="space-y-2 text-sm text-gray-500 dark:text-gray-400">
                <li><a href="#" className="hover:text-black dark:hover:text-white">About</a></li>
                <li><a href="#" className="hover:text-black dark:hover:text-white">Blog</a></li>
                <li><a href="#" className="hover:text-black dark:hover:text-white">Contact</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-black dark:text-white mb-4">Legal</h4>
              <ul className="space-y-2 text-sm text-gray-500 dark:text-gray-400">
                <li><a href="#" className="hover:text-black dark:hover:text-white">Privacy</a></li>
                <li><a href="#" className="hover:text-black dark:hover:text-white">Terms</a></li>
                <li><a href="#" className="hover:text-black dark:hover:text-white">Security</a></li>
              </ul>
            </div>
          </div>
          <div className="text-center text-sm text-gray-500 dark:text-gray-400 pt-8 border-t border-gray-200 dark:border-gray-800">
            © 2024 CloudStorage. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}