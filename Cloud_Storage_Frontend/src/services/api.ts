import axios, { AxiosInstance, AxiosProgressEvent } from 'axios';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '';
interface RequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: any;
    headers?: Record<string, string>;
    isFormData?: boolean;
    onUploadProgress?: (progressEvent: AxiosProgressEvent) => void;
    onDownloadProgress?: (progressEvent: AxiosProgressEvent) => void;
}

class ApiService {
    private baseUrl: string;
    private token: string | null;
    private axiosInstance: AxiosInstance;

    constructor() {
        this.baseUrl = API_BASE_URL;
        this.token = null;

        this.axiosInstance = axios.create({
            baseURL: this.baseUrl,
            timeout: 300000,
            headers: {
                'Content-Type': 'application/json',
            },
        });

        // Request interceptor to add token
        this.axiosInstance.interceptors.request.use(
            (config) => {
                if (this.token) {
                    config.headers.Authorization = `Bearer ${this.token}`;
                }
                return config;
            },
            (error) => Promise.reject(error)
        );

        // Response interceptor for error handling
        this.axiosInstance.interceptors.response.use(
            (response) => response,
            (error) => {
                if (error.response?.status === 401) {
                    this.clearToken();
                    if (typeof window !== 'undefined') {
                        window.location.href = '/login';
                    }
                }
                // No automatic redirect to /reconnect-telegram on a revoked Telegram
                // session — that's a deliberate choice: sign-in stays a plain id+password
                // flow with no OTP interruption, ever. If a file action fails because
                // the Telegram session is dead, it just shows as a normal error; from
                // Settings, "Reconnect Telegram" is available if the user chooses it.
                return Promise.reject(error);
            }
        );
    }

    setToken(token: string) {
        this.token = token;
        if (typeof window !== 'undefined') {
            sessionStorage.setItem('token', token);
        }
    }

    getToken(): string | null {
        if (!this.token && typeof window !== 'undefined') {
            this.token = sessionStorage.getItem('token');
        }
        return this.token;
    }

    clearToken() {
        this.token = null;
        if (typeof window !== 'undefined') {
            sessionStorage.removeItem('token');
        }
    }

    private async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
        const {
            method = 'GET',
            body,
            headers = {},
            isFormData = false,
            onUploadProgress,
            onDownloadProgress
        } = options;

        const config: any = {
            method,
            url: endpoint,
            headers: {
                ...headers,
            },
            onUploadProgress,
            onDownloadProgress,
        };

        if (!isFormData && body) {
            config.data = body;
        } else if (isFormData && body) {
            config.data = body;
            config.headers['Content-Type'] = 'multipart/form-data';
        }

        const response = await this.axiosInstance.request<T>(config);
        return response.data;
    }

    // Auth endpoints
    async sendCode(phoneNumber: string, apiId: number, apiHash: string) {
        return this.request<{ success: boolean; message: string; phoneNumber: string }>('/api/auth/send-code', {
            method: 'POST',
            body: { phoneNumber, apiId, apiHash },
        });
    }

    async verifyCode(phoneNumber: string, code: number, groupUsername?: string, groupId?: string, password?: string) {
        return this.request<{
            success: boolean;
            token: string;
            user: any;
            channels: any[];
        }>('/api/auth/verify', {
            method: 'POST',
            body: { phoneNumber, code, groupUsername, groupId, password },
        });
    }

    async loginWithEmail(identifier: string, password: string) {
        return this.request<{
            success: boolean;
            token: string;
            user: any;
        }>('/api/auth/login', {
            method: 'POST',
            body: { identifier, password },
        });
    }

    // Re-links Telegram when /login reports telegramReconnectRequired — same OTP (+
    // 2FA if needed) dance as signup, but against the already-logged-in user.
    async reconnectTelegramSendCode() {
        return this.request<{ success: boolean; message: string }>('/api/auth/reconnect-send-code', {
            method: 'POST',
        });
    }

    async reconnectTelegramVerify(code?: string, password?: string) {
        return this.request<{
            success: boolean;
            message?: string;
            error?: string;
            requirePassword?: boolean;
            invalidPassword?: boolean;
        }>('/api/auth/reconnect-verify', {
            method: 'POST',
            body: { code, password },
        });
    }

    async completeProfile(email: string, password: string) {
        return this.request<{
            success: boolean;
            message: string;
        }>('/api/auth/complete-profile', {
            method: 'POST',
            body: { email, password },
        });
    }

    async getProfileStatus() {
        return this.request<{
            isProfileComplete: boolean;
            email: string;
            firstName: string;
        }>('/api/auth/profile-status');
    }

    async getMe() {
        return this.request<{ user: any; channels: any[] }>('/api/auth/me');
    }

    async logout() {
        return this.request<{ success: boolean; message: string }>('/api/auth/logout', {
            method: 'POST',
        });
    }

    // Upload endpoints with progress
    async uploadFile(
        file: File,
        channelId?: string,
        onProgress?: (percent: number) => void
    ) {
        const formData = new FormData();
        formData.append('file', file);
        if (channelId) {
            formData.append('channelId', channelId);
        }

        return this.request<{
            success: boolean;
            message: string;
            file: { id: string; name: string; size: number; messageId: string; channelId: string };
        }>('/api/upload', {
            method: 'POST',
            body: formData,
            isFormData: true,
            onUploadProgress: (progressEvent) => {
                if (onProgress && progressEvent.total) {
                    const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                    onProgress(percent);
                }
            },
        });
    }

    async getFiles(limit: number = 50) {
        return this.request<{ success: boolean; count: number; files: any[] }>(`/api/files?limit=${limit}`);
    }

    async getFileById(id: string) {
        return this.request<{ success: boolean; file: any }>(`/api/files/${id}`);
    }

    async deleteFile(id: string) {
        return this.request<{ success: boolean; message: string }>(`/api/files/${id}`, {
            method: 'DELETE',
        });
    }

    async moveFile(id: string, folderId: string | null) {
        return this.request<{ success: boolean }>(`/api/files/${id}/move`, {
            method: 'PUT',
            body: { folderId },
        });
    }

    async copyFile(id: string, folderId: string | null) {
        return this.request<{ success: boolean; file: any }>(`/api/files/${id}/copy`, {
            method: 'POST',
            body: { folderId },
        });
    }

    async searchFiles(query: string) {
        return this.request<{ success: boolean; query: string; count: number; files: any[] }>(`/api/search?q=${encodeURIComponent(query)}`);
    }

    async getStats() {
        return this.request<{ success: boolean; stats: any }>('/api/stats');
    }

    async getChannels() {
        return this.request<{ success: boolean; channels: any[] }>('/api/channels');
    }

    async syncChannels() {
        return this.request<{ success: boolean; synced: number; channels: any[] }>('/api/sync-channels', {
            method: 'POST',
        });
    }

    // File view/download URLs
    getFileViewUrl(messageId: string): string {
        return `${this.baseUrl}/api/view/${messageId}`;
    }

    getFileDownloadUrl(messageId: string): string {
        return `${this.baseUrl}/api/download/${messageId}`;
    }

    // Short-lived token so the browser can download natively (no Authorization header needed),
    // streaming straight to disk instead of buffering the whole file in memory.
    async getDownloadTicket(messageId: string): Promise<string> {
        const { token } = await this.request<{ token: string }>(`/api/download-ticket/${messageId}`);
        return token;
    }

    async viewFileAsBlob(messageId: string, thumbnail: boolean = false): Promise<Blob> {
        const response = await this.axiosInstance.get(`/api/view/${messageId}`, {
            params: thumbnail ? { thumb: '1' } : undefined,
            responseType: 'blob',
        });
        return response.data;
    }

    // Health check
    async healthCheck() {
        return this.request<{ status: string; timestamp: string; maxFileSize: string; database: string }>('/api/health');
    }

    // Initialize token from sessionStorage
    initToken() {
        if (typeof window !== 'undefined') {
            const token = sessionStorage.getItem('token');
            if (token) {
                this.token = token;
            }
        }
    }
}

export const apiService = new ApiService();

// Initialize token on import
if (typeof window !== 'undefined') {
    apiService.initToken();
}

export default apiService;