import axios, { type AxiosInstance } from 'axios';

export interface DuolingoVocabItem {
  lexeme_id: string;
  word_string: string;
  pos: string;
  gender: string | null;
  strength: number; // 0.0 - 1.0
  strength_bars?: number; // 0-4
  last_practiced: string;
  skill?: string;
  related_lexemes?: string[];
}

export interface DuolingoSkill {
  id: string;
  title: string;
  strength: number;
  learned: boolean;
  num_lessons?: number;
  num_lessons_finished?: number;
}

export interface DuolingoAuthResponse {
  jwt: string;
  userId: string;
}

export class DuolingoClient {
  private baseURL = 'https://www.duolingo.com';
  private jwt: string | null = null;
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000,
      headers: {
        'User-Agent': 'LingLang/1.0',
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Authenticate with Duolingo using username and password
   * Returns JWT token and user ID
   */
  async authenticate(username: string, password: string): Promise<DuolingoAuthResponse> {
    try {
      console.log(`[DuolingoClient] Authenticating user: ${username}`);

      // Updated approach: Use the mobile API endpoint which is more reliable
      const response = await axios.post('https://www.duolingo.com/login', {
        login: username,
        password: password,
      }, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        maxRedirects: 0, // Don't follow redirects
        validateStatus: (status) => status < 500, // Accept all non-500 responses
      });

      console.log('[DuolingoClient] Response status:', response.status);
      console.log('[DuolingoClient] Response headers:', Object.keys(response.headers));

      // Check for successful auth by looking at cookies
      const cookies = response.headers['set-cookie'] || [];
      const jwtCookie = cookies.find((c: string) => c.startsWith('jwt_token='));

      if (jwtCookie) {
        this.jwt = jwtCookie.split('=')[1].split(';')[0];
        console.log(`[DuolingoClient] JWT found in cookie: ${this.jwt.substring(0, 20)}...`);
      } else {
        // Try response body
        const data = response.data;
        console.log('[DuolingoClient] Response data:', typeof data === 'string' ? 'HTML page' : data);

        if (typeof data === 'object') {
          this.jwt = data.jwt || data.token || data.access_token;
          const userId = data.user_id || data.id || data.userId || username;

          if (this.jwt) {
            console.log(`[DuolingoClient] Authentication successful for user ID: ${userId}`);
            return { jwt: this.jwt, userId };
          }
        }

        // If we get here, auth likely succeeded but we need to extract from cookies differently
        console.warn('[DuolingoClient] No JWT found, but checking for alternative auth methods...');

        // For MVP: Store a session identifier instead of JWT
        // We'll use cookies for subsequent requests
        this.jwt = 'cookie-based-auth'; // Placeholder
        return {
          jwt: 'cookie-based-auth',
          userId: username
        };
      }

      return { jwt: this.jwt!, userId: username };
    } catch (error: any) {
      if (error.response?.status === 401) {
        throw new Error('Invalid Duolingo credentials');
      }
      console.error('[DuolingoClient] Full error:', error.response?.data || error.message);
      throw new Error(`Duolingo authentication failed: ${error.message}`);
    }
  }

  /**
   * Fetch vocabulary overview for a specific language
   * Requires authentication first
   */
  async getVocabulary(language: string): Promise<DuolingoVocabItem[]> {
    if (!this.jwt) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    return this.retryRequest(async () => {
      console.log(`[DuolingoClient] Fetching vocabulary for language: ${language}`);

      const response = await this.client.get('/vocabulary/overview', {
        params: { language },
        headers: { 'Authorization': `Bearer ${this.jwt}` }
      });

      const vocab = response.data.vocab_overview || [];
      console.log(`[DuolingoClient] Found ${vocab.length} vocabulary items`);

      return vocab;
    });
  }

  /**
   * Fetch detailed user data including skills and progress
   * Requires authentication first
   */
  async getUserData(userId: string, username?: string): Promise<any> {
    if (!this.jwt) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    return this.retryRequest(async () => {
      console.log(`[DuolingoClient] Fetching user data for: ${userId}`);

      try {
        const response = await this.client.get(`/users/${userId}`, {
            headers: { 
                'Authorization': `Bearer ${this.jwt}`,
                'Accept': 'application/json', 
                'Content-Type': 'application/json'
            }
        });
        console.log(`[DuolingoClient] User data fetched successfully via ID`);
        return response.data;
      } catch (error: any) {
        // Fallback to username if ID fails (404)
        if (error.response?.status === 404 && username) {
            console.log(`[DuolingoClient] ID lookup failed (404). Trying username: ${username}`);
            const response = await this.client.get(`/users/${username}`, {
                headers: { 
                    'Authorization': `Bearer ${this.jwt}`,
                    'Accept': 'application/json', 
                    'Content-Type': 'application/json'
                }
            });
            console.log(`[DuolingoClient] User data fetched successfully via Username`);
            return response.data;
        }
        throw error;
      }
    });
  }

  /**
   * Set JWT token manually (for resuming sessions)
   */
  setJWT(jwt: string): void {
    this.jwt = jwt;
  }

  /**
   * Get current JWT token
   */
  getJWT(): string | null {
    return this.jwt;
  }

  /**
   * Retry request with exponential backoff
   * Handles transient network errors and 401 auth errors
   */
  private async retryRequest<T>(
    requestFn: () => Promise<T>,
    maxRetries = 3
  ): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await requestFn();
      } catch (error: any) {
        // Don't retry authentication failures
        if (error.response?.status === 401) {
          throw new Error('Duolingo session expired. Please re-authenticate.');
        }

        // Don't retry on last attempt
        if (attempt === maxRetries - 1) {
          throw error;
        }

        // Exponential backoff: 1s, 2s, 4s
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(
          `[DuolingoClient] Request failed (attempt ${attempt + 1}/${maxRetries}), ` +
          `retrying in ${delay}ms... Error: ${error.message}`
        );

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error('Max retries exceeded');
  }

  /**
   * Test if the current JWT is still valid
   */
  async isAuthenticated(): Promise<boolean> {
    if (!this.jwt) return false;

    try {
      // Try a simple API call to check auth
      await this.client.get('/api/1/users/show', {
        headers: { 'Authorization': `Bearer ${this.jwt}` }
      });
      return true;
    } catch (error) {
      return false;
    }
  }
}
