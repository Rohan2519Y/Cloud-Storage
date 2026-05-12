'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Moon, Sun } from 'lucide-react';

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState('dark');
  const [scrolled, setScrolled] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Init theme
  useEffect(() => {
    const stored = localStorage.getItem('theme') || 'dark';
    setTheme(stored);
    document.documentElement.classList.toggle('dark', stored === 'dark');
  }, []);

  // Scroll shadow
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Lock body scroll when menu open
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [menuOpen]);

  // Close on outside tap
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [menuOpen]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('theme', next);
    document.documentElement.classList.toggle('dark', next === 'dark');
  };

  const closeMenu = () => setMenuOpen(false);

  const navLinks = [
    { label: 'Features', href: '#features' },
    { label: 'How it Works', href: '#how-it-works' },
    { label: 'FAQ', href: '#faq' },
  ];

  return (
    <>
      <header
        ref={menuRef}
        className={`
          fixed top-0 left-0 right-0 z-50
          bg-white dark:bg-black
          transition-shadow duration-200
          ${scrolled ? 'shadow-[0_1px_0_0_rgba(0,0,0,0.08)] dark:shadow-[0_1px_0_0_rgba(255,255,255,0.08)]' : ''}
        `}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between h-16">

            {/* Logo */}
            <Link
              href="/"
              onClick={closeMenu}
              className="flex items-center gap-2 shrink-0 select-none"
            >
              <span className="text-xl leading-none">📁</span>
              <span className="font-bold text-base tracking-tight text-black dark:text-white">
                CloudStorage
              </span>
            </Link>

            {/* Desktop Nav */}
            <nav className="hidden md:flex items-center gap-1">
              {navLinks.map(link => (
                <a
                  key={link.href}
                  href={link.href}
                  className="px-4 py-2 text-sm text-zinc-500 dark:text-zinc-400 hover:text-black dark:hover:text-white rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
                >
                  {link.label}
                </a>
              ))}
            </nav>

            {/* Desktop Actions */}
            <div className="hidden md:flex items-center gap-2">
              <button
                onClick={toggleTheme}
                className="p-2 rounded-lg text-zinc-500 hover:text-black dark:text-zinc-400 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
                aria-label="Toggle theme"
              >
                {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
              </button>
              <Link
                href="/login"
                className="px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:text-black dark:hover:text-white transition-colors"
              >
                Sign In
              </Link>
              <Link
                href="/signup"
                className="px-4 py-2 text-sm font-semibold bg-black dark:bg-white text-white dark:text-black rounded-xl hover:opacity-85 transition-opacity active:scale-95"
              >
                Get Started
              </Link>
            </div>

            {/* Mobile: theme + hamburger */}
            <div className="flex items-center gap-1 md:hidden">
              <button
                onClick={toggleTheme}
                className="p-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
                aria-label="Toggle theme"
              >
                {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
              </button>

              {/* Hamburger — pure CSS animated, no SVG swap needed */}
              <button
                onClick={() => setMenuOpen(v => !v)}
                aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={menuOpen}
                className="relative w-10 h-10 flex items-center justify-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
              >
                <span className="sr-only">{menuOpen ? 'Close' : 'Menu'}</span>
                <div className="w-5 flex flex-col gap-[5px] items-end">
                  <span
                    className={`block h-[1.5px] bg-zinc-800 dark:bg-zinc-200 rounded-full transition-all duration-300 origin-center
                      ${menuOpen ? 'w-5 translate-y-[6.5px] rotate-45' : 'w-5'}`}
                  />
                  <span
                    className={`block h-[1.5px] bg-zinc-800 dark:bg-zinc-200 rounded-full transition-all duration-300
                      ${menuOpen ? 'w-0 opacity-0' : 'w-3.5'}`}
                  />
                  <span
                    className={`block h-[1.5px] bg-zinc-800 dark:bg-zinc-200 rounded-full transition-all duration-300 origin-center
                      ${menuOpen ? 'w-5 -translate-y-[6.5px] -rotate-45' : 'w-5'}`}
                  />
                </div>
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Dropdown — inside header so ref works */}
        <div
          className={`
            md:hidden overflow-hidden transition-all duration-300 ease-in-out
            border-t border-zinc-100 dark:border-zinc-900
            bg-white dark:bg-black
            ${menuOpen ? 'max-h-[400px] opacity-100' : 'max-h-0 opacity-0 pointer-events-none'}
          `}
        >
          <nav className="px-4 pt-3 pb-2 space-y-0.5">
            {navLinks.map(link => (
              <a
                key={link.href}
                href={link.href}
                onClick={closeMenu}
                className="flex items-center px-4 py-3 text-base font-medium text-zinc-700 dark:text-zinc-300 hover:text-black dark:hover:text-white hover:bg-zinc-50 dark:hover:bg-zinc-900 rounded-xl transition-colors active:bg-zinc-100 dark:active:bg-zinc-800"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="px-4 pb-5 pt-2 space-y-2.5 border-t border-zinc-100 dark:border-zinc-900 mt-1">
            <Link
              href="/login"
              onClick={closeMenu}
              className="flex items-center justify-center w-full py-3 text-sm font-semibold text-black dark:text-white border border-zinc-200 dark:border-zinc-800 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors active:scale-[0.98]"
            >
              Sign In
            </Link>
            <Link
              href="/signup"
              onClick={closeMenu}
              className="flex items-center justify-center w-full py-3 text-sm font-semibold bg-black dark:bg-white text-white dark:text-black rounded-xl hover:opacity-85 transition-opacity active:scale-[0.98]"
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>

      {/* Backdrop — outside header so it covers full screen */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 dark:bg-black/40 backdrop-blur-[2px] md:hidden"
          onClick={closeMenu}
          aria-hidden="true"
        />
      )}

      {/* Spacer */}
      <div className="h-16" />
    </>
  );
}