'use client'

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Files,
  HardDrive,
  Upload,
  TrendingUp,
  FolderOpen,
  Clock,
  ArrowUpRight,
  Loader2,
  FileText,
  FileImage,
  FileVideo,
  FileArchive,
  File,
  Download,
  Eye,
} from "lucide-react";
import apiService from "@/services/api";

interface DashboardStats {
  totalFiles: number;
  totalSizeInMB: string;
  totalSizeInGB: string;
}

interface FileItem {
  id: string;
  original_name: string;
  file_size: number;
  mime_type: string;
  telegram_message_id: string;
  channel_id: string;
  created_at: string;
}

interface Channel {
  channel_id: string;
  channel_title: string;
  channel_username: string;
}

export default function Dashboard() {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentFiles, setRecentFiles] = useState<FileItem[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setMounted(true);
    const userData = sessionStorage.getItem('telegram_user_account');
    if (userData) {
      setUser(JSON.parse(userData));
      apiService.initToken();
      fetchDashboardData();
    } else {
      router.push('/login');
    }
  }, [router]);

  const fetchDashboardData = async () => {
    try {
      const [statsData, filesData, channelsData] = await Promise.all([
        apiService.getStats(),
        apiService.getFiles(5),
        apiService.getChannels(),
      ]);

      if (statsData.success) setStats(statsData.stats);
      if (filesData.success) setRecentFiles(filesData.files || []);
      if (channelsData.success) setChannels(channelsData.channels || []);
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType?.startsWith('image/')) return FileImage;
    if (mimeType?.startsWith('video/')) return FileVideo;
    if (mimeType?.startsWith('audio/')) return FileImage;
    if (mimeType?.includes('zip') || mimeType?.includes('rar')) return FileArchive;
    if (mimeType?.includes('pdf') || mimeType?.includes('doc') || mimeType?.includes('txt')) return FileText;
    return File;
  };

  if (!mounted) return null;

  const statCards = [
    {
      label: 'Total Files',
      value: loading ? '—' : stats?.totalFiles ?? 0,
      icon: Files,
      color: 'from-blue-500 to-cyan-500',
    },
    {
      label: 'Storage Used',
      value: loading ? '—' : `${stats?.totalSizeInGB ?? '0'} GB`,
      sub: loading ? '' : `${stats?.totalSizeInMB ?? '0'} MB`,
      icon: HardDrive,
      color: 'from-purple-500 to-pink-500',
    },
    {
      label: 'Channels',
      value: loading ? '—' : channels.length,
      icon: FolderOpen,
      color: 'from-green-500 to-emerald-500',
    },
    {
      label: 'Recent Uploads',
      value: loading ? '—' : recentFiles.length,
      icon: TrendingUp,
      color: 'from-orange-500 to-yellow-500',
    },
  ];

  return (
    <div className="p-6 lg:p-10">
      {/* Welcome Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-black dark:text-white">
          Welcome back{user?.firstName ? `, ${user.firstName}` : ''} 👋
        </h1>
        <p className="mt-2 text-zinc-500 dark:text-zinc-400">
          Here's what's happening with your cloud storage.
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
        {statCards.map((card, index) => (
          <div
            key={index}
            className="relative overflow-hidden rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-6 transition-all hover:border-zinc-400 dark:hover:border-zinc-600"
          >
            <div className="flex items-start justify-between mb-4">
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${card.color}`}>
                <card.icon size={20} className="text-white" />
              </div>
            </div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">{card.label}</p>
            <p className="text-2xl font-bold text-black dark:text-white mt-1">
              {loading ? <Loader2 size={20} className="animate-spin" /> : card.value}
            </p>
            {card.sub && (
              <p className="text-xs text-zinc-400 mt-1">{card.sub}</p>
            )}
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent Files */}
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-black dark:text-white">Recent Files</h2>
            <button
              onClick={() => router.push('/dashboard/files')}
              className="inline-flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-black dark:hover:text-white transition-colors"
            >
              View all <ArrowUpRight size={14} />
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-zinc-400" />
            </div>
          ) : recentFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <File size={36} className="text-zinc-300 dark:text-zinc-700 mb-3" />
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No files uploaded yet</p>
              <button
                onClick={() => router.push('/dashboard/files')}
                className="mt-3 inline-flex items-center gap-2 rounded-lg bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
              >
                <Upload size={14} /> Upload Files
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {recentFiles.map((file) => {
                const Icon = getFileIcon(file.mime_type);
                return (
                  <div
                    key={file.id}
                    className="flex items-center gap-3 p-3 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
                    onClick={() => router.push('/dashboard/files')}
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-black/10 dark:bg-white/10 flex-shrink-0">
                      <Icon size={18} className="text-black dark:text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-black dark:text-white truncate">
                        {file.original_name}
                      </p>
                      <p className="text-xs text-zinc-400">
                        {formatFileSize(file.file_size)} · {formatDate(file.created_at)}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          apiService.downloadFileAsBlob(file.telegram_message_id).then(blob => {
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url; a.download = file.original_name;
                            a.click();
                            URL.revokeObjectURL(url);
                          });
                        }}
                        className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-black dark:hover:text-white"
                      >
                        <Download size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Channels */}
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-black dark:text-white">Your Channels</h2>
            <button
              onClick={() => router.push('/dashboard/channels')}
              className="inline-flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-black dark:hover:text-white transition-colors"
            >
              View all <ArrowUpRight size={14} />
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-zinc-400" />
            </div>
          ) : channels.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12">
              <FolderOpen size={36} className="text-zinc-300 dark:text-zinc-700 mb-3" />
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No channels connected</p>
            </div>
          ) : (
            <div className="space-y-3">
              {channels.map((channel) => (
                <div
                  key={channel.channel_id}
                  className="flex items-center gap-3 p-3 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-colors"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-green-500 to-emerald-500 flex-shrink-0">
                    <FolderOpen size={18} className="text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-black dark:text-white truncate">
                      {channel.channel_title || channel.channel_username || 'Channel'}
                    </p>
                    <p className="text-xs text-zinc-400">
                      {channel.channel_username ? `@${channel.channel_username}` : `ID: ${channel.channel_id}`}
                    </p>
                  </div>
                  <span className="inline-flex items-center rounded-full bg-green-100 dark:bg-green-950 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-400">
                    Active
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <button
          onClick={() => router.push('/dashboard/files')}
          className="flex items-center gap-3 p-4 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 hover:border-zinc-400 dark:hover:border-zinc-600 transition-all group"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-black dark:bg-white">
            <Upload size={18} className="text-white dark:text-black" />
          </div>
          <div className="text-left">
            <p className="text-sm font-medium text-black dark:text-white">Upload Files</p>
            <p className="text-xs text-zinc-400">Upload to Telegram</p>
          </div>
        </button>

        <button
          onClick={() => router.push('/dashboard/files')}
          className="flex items-center gap-3 p-4 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 hover:border-zinc-400 dark:hover:border-zinc-600 transition-all group"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-black dark:bg-white">
            <Files size={18} className="text-white dark:text-black" />
          </div>
          <div className="text-left">
            <p className="text-sm font-medium text-black dark:text-white">Browse Files</p>
            <p className="text-xs text-zinc-400">View all files</p>
          </div>
        </button>

        <button
          onClick={() => router.push('/dashboard/settings')}
          className="flex items-center gap-3 p-4 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 hover:border-zinc-400 dark:hover:border-zinc-600 transition-all group"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-black dark:bg-white">
            <Clock size={18} className="text-white dark:text-black" />
          </div>
          <div className="text-left">
            <p className="text-sm font-medium text-black dark:text-white">Settings</p>
            <p className="text-xs text-zinc-400">Manage account</p>
          </div>
        </button>
      </div>
    </div>
  );
}