/**
 * VS Code 主题管理扩展
 * 
 * 主要功能：
 * 1. 主题收藏和管理
 * 2. 用户行为日志记录
 * 3. 主题切换和状态栏操作
 * 
 * 架构组成：
 * - HttpClient: HTTP 请求处理
 * - ThemeManager: 主题管理
 * - UserManager: 用户管理
 * - ExtensionState: 扩展状态管理
 * - ExtensionController: 扩展控制器
 */

import * as vscode from 'vscode';
import * as XLSX from 'xlsx';
import ActionLogger from './ActionLogger';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';


// 全局配置定义
const CONFIG = {
    SERVER: {
        HOST: '',// TODO 配置目标服务器ip
        PORT: 8080,
        PROTOCOL: 'http',
        RETRY_ATTEMPTS: 3,			// 请求失败重试次数
        RETRY_DELAY: 1000,			// 重试间隔基础时间(ms)
        TIMEOUT: 5000,				 // 请求超时时间(ms)
        KEEPALIVE_TIMEOUT: 60000,  // Nginx keepalive 超时时间(ms)
        MAX_HEADERS: 100,          // Nginx 默认最大请求头数量
        REQUEST_TIMEOUT: 10000     // 最大请求持续时间(ms)
    },
    PATHS: {
        VALIDATE_USER: '/validate_user', // 用户验证接口
        LOG: '/log'						  // 日志记录接口
    },
    FILES: {
        THEMES_DB: 'Themes Database.xlsx', // 主题数据库文件
        FAVORITE: 'Favorite.xlsx',			// 收藏主题存储文件
        USERNAME_CACHE: '.usernameCache.json' // 用户信息缓存文件
    },
    CACHE: {
        MAX_RETRIES: 3,			 // 最大重试次数
        RETRY_DELAY: 1000,		// 重试延迟时间(ms)
        MAX_QUEUE_SIZE: 1000	// 最大队列大小
    }
};

/**
 * 接口定义
 */
// 主题数据结构
interface XLSX_Data {
    Themes: string;	// 主题名称
    Score: number;	// 主题评分
}
// 状态栏项配置
interface StatusBarItems {
    like: vscode.StatusBarItem; 	 // 收藏按钮
    dislike: vscode.StatusBarItem;	 // 取消收藏按钮
    select: vscode.StatusBarItem;	// 选择主题按钮
    default: vscode.StatusBarItem;	// 默认主题按钮
    next: vscode.StatusBarItem;		 // 下一个主题按钮
}

interface RequestOptions extends http.RequestOptions {
    timeout?: number;
}

interface HttpResponse {
    statusCode: number;				 // 响应状态码
    data: string;						 // 响应数据
    headers?: http.IncomingHttpHeaders;	// 响应头
}

/**
 * HTTP客户端实现
 * 特点：
 * 1. 单例模式
 * 2. 支持请求重试
 * 3. 请求队列管理
 * 4. Nginx兼容性配置
 */
class HttpClient {
    private static instance: HttpClient;
    private requestQueue: Array<() => Promise<any>> = [];
    private isProcessingQueue = false;
    private agent: http.Agent;

    private constructor() {
        this.agent = new http.Agent({
            keepAlive: true,
            keepAliveMsecs: CONFIG.SERVER.KEEPALIVE_TIMEOUT,
            maxSockets: 100
        });
    }
	/**
    * 获取HttpClient单例
    * 确保整个扩展中只有一个HTTP客户端实例
    */
    static getInstance(): HttpClient {
        if (!this.instance) {
            this.instance = new HttpClient();
        }
        return this.instance;
    }
	/**
    * 处理请求队列
    * 按顺序处理队列中的请求，防止服务器过载
    */
    private async processQueue(): Promise<void> {
        if (this.isProcessingQueue || this.requestQueue.length === 0) {
            return;
        }

        this.isProcessingQueue = true;
        while (this.requestQueue.length > 0) {
            const request = this.requestQueue.shift();
            if (request) {
                try {
                    await request();
                } catch (error) {
                    console.error('Error processing queued request:', error);
                }
                // Add a small delay between requests to prevent overwhelming the server
                await this.delay(100);
            }
        }
        this.isProcessingQueue = false;
    }
	/**
    * 发送HTTP请求
    * @param options 请求配置选项
    * @param postData POST数据
    * @param retryCount 当前重试次数
    * 
    * 特点：
    * 1. 自动重试机制
    * 2. 队列管理
    * 3. 超时处理
    * 4. Nginx兼容性支持
    */
    async request(options: RequestOptions, postData?: string, retryCount = 0): Promise<HttpResponse> {
        // Add custom headers for nginx
        const enhancedOptions: RequestOptions = {
            ...options,
            agent: this.agent,
            headers: {
                ...options.headers,
                'Connection': 'keep-alive',
                'X-Real-IP': '${req.connection.remoteAddress}',
                'X-Forwarded-For': '${req.connection.remoteAddress}'
            }
        };

        return new Promise((resolve, reject) => {
            const req = http.request(enhancedOptions, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({
                            statusCode: res.statusCode,
                            data,
                            headers: res.headers
                        });
                    } else {
                        reject(new Error(`HTTP Error: ${res.statusCode}`));
                    }
                });
            });

            // Set timeout
            req.setTimeout(options.timeout || CONFIG.SERVER.TIMEOUT, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            // Error handling with retry logic
            req.on('error', async (error) => {
                if (retryCount < CONFIG.SERVER.RETRY_ATTEMPTS) {
                    await this.delay(CONFIG.SERVER.RETRY_DELAY * Math.pow(2, retryCount));
                    try {
                        const result = await this.request(options, postData, retryCount + 1);
                        resolve(result);
                    } catch (retryError) {
                        reject(retryError);
                    }
                } else {
                    // Queue failed request for later retry
                    if (this.requestQueue.length < CONFIG.CACHE.MAX_QUEUE_SIZE) {
                        this.requestQueue.push(async () => {
                            try {
                                return await this.request(options, postData, 0);
                            } catch (error) {
                                console.error('Failed to process queued request:', error);
                                throw error;
                            }
                        });
                        this.processQueue().catch(console.error);
                    }
                    reject(error);
                }
            });

            if (postData) {
                req.write(postData);
            }
            req.end();
        });
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Method to clear the request queue
    clearQueue(): void {
        this.requestQueue = [];
    }

    // Method to get queue size
    getQueueSize(): number {
        return this.requestQueue.length;
    }
}
/**
* 主题管理器
* 负责处理主题相关的所有操作，包括：
* 1. 主题数据加载和保存
* 2. 收藏主题管理
* 3. 状态栏交互
* 4. 主题切换逻辑
*/
class ThemeManager {
    private jsonData: any[];		// 所有主题数据
    private jsonFavorite: any[];	// 收藏的主题数据
    private context: vscode.ExtensionContext;
    private statusBarItems: StatusBarItems;
    private logger: ActionLogger;
    private disposables: vscode.Disposable[] = [];

	/**
    * 构造函数
    * @param context VS Code扩展上下文
    * @param logger 日志记录器
    */
    constructor(context: vscode.ExtensionContext, logger: ActionLogger) {
        this.context = context;
        this.logger = logger;
        this.jsonData = [];
        this.jsonFavorite = [];
        this.statusBarItems = this.createStatusBarItems();
    }

	/**
    * 创建状态栏项
    * 创建并配置所有状态栏按钮
    */
    private createStatusBarItems(): StatusBarItems {
        const items: StatusBarItems = {
            like: this.createStatusBarItem('$(heart)', 'Add to Favorites', 'MyTheme.like', 601),
            dislike: this.createStatusBarItem('$(trash)', 'Remove from Favorites', 'MyTheme.dislike', 602),
            select: this.createStatusBarItem('$(arrow-up)', 'Select from Favorites', 'mytheme.openFavoriteThemesList', 603),
            default: this.createStatusBarItem('$(reply)', 'Reset to Default Theme', 'mytheme.defaultTheme', 604),
            next: this.createStatusBarItem('$(refresh)', "I'm Feeling Lucky", 'mytheme.nextTheme', 605)
        };

        // 显示固定显示的按钮
        items.select.show();
        items.default.show();
        items.next.show();

        return items;
    }

	/**
    * 创建单个状态栏项
    * @param text 显示的图标
    * @param tooltip 鼠标悬停提示
    * @param command 点击触发的命令
    * @param priority 显示优先级
    */
    private createStatusBarItem(
        text: string, 
        tooltip: string, 
        command: string, 
        priority: number
    ): vscode.StatusBarItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
        item.text = text;
        item.tooltip = tooltip;
        item.command = command;
        this.disposables.push(item);
        return item;
    }


   /**
    * 初始化主题管理器
    * 1. 加载主题数据
    * 2. 加载收藏数据
    * 3. 注册命令
    * 4. 设置状态栏
    * 5. 监听主题变更
    */
    async initialize(): Promise<void> {
        try {
            await this.loadThemesData();
            await this.loadFavoriteThemes();
            this.registerCommands();
            await this.updateStatusBarVisibility();
            
            // 监听主题变更事件
            this.disposables.push(
                vscode.workspace.onDidChangeConfiguration(async e => {
                    if (e.affectsConfiguration('workbench.colorTheme')) {
                        await this.handleThemeChange(
                            vscode.workspace.getConfiguration().get('workbench.colorTheme') as string
                        );
                    }
                })
            );
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to initialize theme manager: ${errorMessage}`);
            // Re-throw to prevent partial initialization
            throw error;
        }
    }

	/**
    * 加载主题数据库
    * 从xlsx文件中读取所有主题数据并进行验证和排序
    */
    private async loadThemesData(): Promise<void> {
        try {
            const themesFile = path.join(__dirname, '..', CONFIG.FILES.THEMES_DB);
            if (!fs.existsSync(themesFile)) {
                throw new Error(`Themes database file not found: ${themesFile}`);
            }

            const workbook = XLSX.readFile(themesFile);
            if (!workbook.SheetNames.length) {
                throw new Error('Themes database file is empty');
            }

            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            this.jsonData = XLSX.utils.sheet_to_json(worksheet);
            
            if (!Array.isArray(this.jsonData) || !this.jsonData.length) {
                throw new Error('No theme data found in database');
            }

            // Validate and sort theme data
            this.jsonData = this.jsonData
                .filter(item => item.Themes && typeof item.Score === 'number')
                .sort((a: XLSX_Data, b: XLSX_Data) => b.Score - a.Score);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to load themes database: ${errorMessage}`);
        }
    }

    private async loadFavoriteThemes(): Promise<void> {
        try {
            const favoriteFile = path.join(__dirname, '..', CONFIG.FILES.FAVORITE);
            
            if (fs.existsSync(favoriteFile)) {
                const workbook = XLSX.readFile(favoriteFile);
                const worksheet = workbook.Sheets[workbook.SheetNames[0]];
                this.jsonFavorite = XLSX.utils.sheet_to_json(worksheet);
            } else {
                // 如果收藏文件不存在，使用默认的前10个主题
                this.jsonFavorite = this.jsonData.slice(0, 10);
                await this.saveFavoriteThemes();
            }

            // 验证和排序收藏的主题
            this.jsonFavorite = this.jsonFavorite
                .filter(item => item.Themes && typeof item.Score === 'number')
                .sort((a: XLSX_Data, b: XLSX_Data) => b.Score - a.Score);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to load favorite themes: ${errorMessage}`);
        }
    }

	/**
    * 保存收藏主题列表
    * 使用原子写操作确保文件写入的可靠性
    */
    private async saveFavoriteThemes(): Promise<void> {
        try {
            const worksheet = XLSX.utils.json_to_sheet(this.jsonFavorite);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
            
            const favoriteFile = path.join(__dirname, '..', CONFIG.FILES.FAVORITE);
            const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
            
             // 使用临时文件进行原子写入
            const tempFile = `${favoriteFile}.tmp`;
            await fs.promises.writeFile(tempFile, excelBuffer);
            await fs.promises.rename(tempFile, favoriteFile);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to save favorite themes: ${errorMessage}`);
            throw error;
        }
    }

	/**
    * 注册命令处理器
    * 注册所有主题相关的命令
    */
    private registerCommands(): void {
        this.disposables.push(
            vscode.commands.registerCommand('mytheme.openFavoriteThemesList', () => this.showFavoriteThemesList()),
            vscode.commands.registerCommand('MyTheme.like', () => this.handleLikeTheme()),
            vscode.commands.registerCommand('MyTheme.dislike', () => this.handleDislikeTheme()),
            vscode.commands.registerCommand('mytheme.defaultTheme', () => this.handleDefaultTheme()),
            vscode.commands.registerCommand('mytheme.nextTheme', () => this.handleNextTheme())
        );
    }
	
	/**
    * 显示收藏主题列表
    * 创建快速选择面板，显示所有收藏的主题
    */
    private async showFavoriteThemesList(): Promise<void> {
        try {
            const installedThemes = await this.getAllThemes();
            const items: vscode.QuickPickItem[] = this.jsonFavorite.map(theme => {
                const themeName = theme.Themes.toString();
                const isInstalled = installedThemes.includes(themeName);
                const currentTheme = vscode.workspace.getConfiguration().get('workbench.colorTheme');
                const isCurrent = themeName === currentTheme;

                return {
                    label: isCurrent ? `* ${themeName}` : themeName,
                    description: !isInstalled ? 'Not Installed' : undefined,
                    detail: `Score: ${theme.Score}`,
                };
            });
			// 显示选择面板
            const selectedItem = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a theme from your favorites',
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (selectedItem) {
                const themeName = selectedItem.label.replace('* ', '');
				// 检查主题是否已安装
                if (!installedThemes.includes(themeName)) {
                    await vscode.window.showWarningMessage(
                        `Theme "${themeName}" is not installed. Would you like to install it?`,
                        'Yes',
                        'No'
                    ).then(async response => {
                        if (response === 'Yes') {
                            // Open VSCode marketplace for the theme
                            await vscode.commands.executeCommand(
                                'workbench.extensions.search',
                                `@category:"themes" ${themeName}`
                            );
                        }
                    });
                    return;
                }

                await this.handleThemeChange(themeName);
                await this.logger.logAction('select_favorite_theme', { selectedTheme: themeName });
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to show favorite themes: ${errorMessage}`);
        }
    }

	/**
    * 处理收藏主题操作
    * 将当前主题添加到收藏列表
    */
    private async handleLikeTheme(): Promise<void> {
        try {
            const currentTheme = vscode.workspace.getConfiguration().get('workbench.colorTheme') as string;
            const themeData = this.jsonData.find(item => item.Themes === currentTheme);

            if (themeData) {
                if (!this.jsonFavorite.some(item => item.Themes === currentTheme)) {
                    this.jsonFavorite.push(themeData);
                    this.jsonFavorite.sort((a: XLSX_Data, b: XLSX_Data) => b.Score - a.Score);
                    await this.saveFavoriteThemes();
                    await this.updateStatusBarVisibility();
                    await this.logger.logAction('add_favorite_theme', { theme: currentTheme });
                    vscode.window.showInformationMessage(`Added "${currentTheme}" to favorites`);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to add theme to favorites: ${errorMessage}`);
        }
    }
	/**
    * 处理取消收藏操作
    * 从收藏列表中移除当前主题
    */
    private async handleDislikeTheme(): Promise<void> {
        try {
            const currentTheme = vscode.workspace.getConfiguration().get('workbench.colorTheme') as string;
            const index = this.jsonFavorite.findIndex(item => item.Themes === currentTheme);

            if (index !== -1) {
                this.jsonFavorite.splice(index, 1);
                await this.saveFavoriteThemes();
                await this.updateStatusBarVisibility();
                await this.logger.logAction('remove_favorite_theme', { theme: currentTheme });
                vscode.window.showInformationMessage(`Removed "${currentTheme}" from favorites`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to remove theme from favorites: ${errorMessage}`);
        }
    }
	/**
    * 切换到默认主题
    * 将主题设置为VS Code默认的深色主题
    */
    private async handleDefaultTheme(): Promise<void> {
        try {
            const defaultTheme = 'Visual Studio Dark';
            await this.handleThemeChange(defaultTheme);
            await this.logger.logAction('reset_default_theme', { theme: defaultTheme });
            vscode.window.showInformationMessage('Reset to default theme');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to set default theme: ${errorMessage}`);
        }
    }

	/**
    * 切换到下一个主题
    * 根据评分顺序循环切换已安装的主题
    */
    private async handleNextTheme(): Promise<void> {
        try {
            const installedThemes = await this.getAllThemes();
            const currentTheme = vscode.workspace.getConfiguration().get('workbench.colorTheme') as string;
            
            // 获取可用主题列表
            const availableThemes = this.jsonData
                .filter(item => installedThemes.includes(item.Themes))
                .map(item => item.Themes);

            if (availableThemes.length === 0) {
                vscode.window.showWarningMessage('No themes available');
                return;
            }

            // 循环选择下一个主题
            const currentIndex = availableThemes.indexOf(currentTheme);
            const nextIndex = (currentIndex + 1) % availableThemes.length;
            const nextTheme = availableThemes[nextIndex];

            await this.handleThemeChange(nextTheme);
            
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to switch to next theme: ${errorMessage}`);
        }
    }

    /**
    * 获取所有已安装的主题
    * 扫描VS Code扩展中的主题贡献
    */
    private async getAllThemes(): Promise<string[]> {
        try {
            const allExtensions = vscode.extensions.all;
			 // 筛选包含主题的扩展
            const themeExtensions = allExtensions.filter(extension => {
                const contributes = extension.packageJSON?.contributes;
                return contributes?.themes?.length > 0;
            });
			// 提取主题名称
            const themeNames: Set<string> = new Set();
            themeExtensions.forEach(extension => {
                const contributes = extension.packageJSON?.contributes;
                const themes = contributes?.themes || [];
                themes.forEach((theme: { label: string; uiTheme: string }) => {
                    if (theme.label && theme.uiTheme) {
                        themeNames.add(theme.label);
                    }
                });
            });

            return Array.from(themeNames);
        } catch (error) {
            console.error('Error getting all themes:', error);
            return [];
        }
    }

	/**
    * 更新状态栏显示状态
    * 根据当前主题是否在收藏列表中来显示或隐藏相应按钮
    */
    private async updateStatusBarVisibility(): Promise<void> {
        try {
            const currentTheme = vscode.workspace.getConfiguration().get('workbench.colorTheme') as string;
            const isFavorite = this.jsonFavorite.some(item => item.Themes === currentTheme);

            // 更新按钮显示状态
            this.statusBarItems.like.hide();
            this.statusBarItems.dislike.hide();

            if (isFavorite) {
                this.statusBarItems.dislike.show();
            } else {
                this.statusBarItems.like.show();
            }

        } catch (error) {
            console.error('Error updating status bar visibility:', error);
        }
    }
	/**
    * 处理主题变更
    * 执行主题切换并记录相关日志
    * @param newTheme 新主题名称
    */
    private async handleThemeChange(newTheme: string): Promise<void> {
        try {
            const oldTheme = vscode.workspace.getConfiguration().get('workbench.colorTheme');
            
            await vscode.workspace.getConfiguration().update(
                'workbench.colorTheme',
                newTheme,
                vscode.ConfigurationTarget.Global
            );

            await this.updateStatusBarVisibility();
            
            // Log theme change
            await this.logger.logAction('theme_changed', {
                oldTheme,
                newTheme,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to change theme: ${errorMessage}`);
        }
    }


    dispose(): void {
        //this.backup().catch(console.error);
        this.disposables.forEach(d => d.dispose());
        Object.values(this.statusBarItems).forEach(item => item.dispose());
    }
}
/**
* 用户管理器
* 负责用户身份验证和本地缓存管理
*/
class UserManager {
    private context: vscode.ExtensionContext;
    private httpClient: HttpClient;
    private static readonly MAX_VALIDATION_RETRIES = 3; // 最大验证重试次数
    private static readonly VALIDATION_RETRY_DELAY = 1000;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.httpClient = HttpClient.getInstance();
    }

	 /**
    * 验证并缓存用户名
    * @param userId 用户ID
    * @returns 验证是否成功
    * 
    * 特点：
    * 1. 支持重试机制
    * 2. 错误状态处理
    * 3. 自动缓存验证成功的用户信息
    */
    async validateAndCacheUsername(userId: string): Promise<boolean> {
        if (!userId || userId.trim().length === 0) {
            throw new Error('User ID cannot be empty');
        }

        const postData = JSON.stringify({ username: userId.trim() });
        const options: http.RequestOptions = {
            hostname: CONFIG.SERVER.HOST,
            port: CONFIG.SERVER.PORT,
            path: CONFIG.PATHS.VALIDATE_USER,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        let lastError: Error | null = null;
		// 重试循环
        for (let attempt = 1; attempt <= UserManager.MAX_VALIDATION_RETRIES; attempt++) {
            try {
                const response = await this.httpClient.request(options, postData);
                
                if (response.statusCode === 200) {
                    await this.cacheUsername(userId);
                    return true;
                }
                
                // 处理不同的HTTP状态码
                switch (response.statusCode) {
                    case 400:
                        throw new Error('Invalid user ID');
                    case 429:
                        // Rate limiting - wait longer before retry
                        await this.delay(UserManager.VALIDATION_RETRY_DELAY * Math.pow(2, attempt));
                        continue;
                    default:
                        throw new Error(`Server returned status code: ${response.statusCode}`);
                }
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                
                if (attempt < UserManager.MAX_VALIDATION_RETRIES) {
                    // Wait before retrying
                    await this.delay(UserManager.VALIDATION_RETRY_DELAY * Math.pow(2, attempt));
                }
            }
        }

        if (lastError) {
            throw new Error(`User validation failed after ${UserManager.MAX_VALIDATION_RETRIES} attempts: ${lastError.message}`);
        }

        return false;
    }
	/**
    * 缓存用户名
    * 使用原子写入确保数据完整性
    * @param username 用户名
    */
    private async cacheUsername(username: string): Promise<void> {
        try {
            const cacheDir = path.dirname(this.getUsernameCacheFilePath());
            await fs.promises.mkdir(cacheDir, { recursive: true });

            // Write to temporary file first
            const tempFile = `${this.getUsernameCacheFilePath()}.tmp`;
            await fs.promises.writeFile(
                tempFile,
                JSON.stringify({ 
                    username,
                    timestamp: new Date().toISOString()
                }),
                'utf8'
            );

            // Rename temp file to actual file (atomic operation)
            await fs.promises.rename(tempFile, this.getUsernameCacheFilePath());

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to cache username: ${errorMessage}`);
        }
    }

	/**
    * 获取缓存的用户名
    * 读取并验证本地缓存的用户信息
    */
    async getCachedUsername(): Promise<string> {
        try {
            const cacheFile = this.getUsernameCacheFilePath();
            if (await this.fileExists(cacheFile)) {
                const data = await fs.promises.readFile(cacheFile, 'utf8');
                const cache = JSON.parse(data);
                
                // Validate cached data
                if (this.isValidCacheData(cache)) {
                    return cache.username;
                }
            }
        } catch (error) {
            console.error('Failed to get cached username:', error);
        }
        return 'undefined';
    }
	/**
    * 获取用户名缓存文件路径
    */
    private getUsernameCacheFilePath(): string {
        return path.join(this.context.globalStoragePath, CONFIG.FILES.USERNAME_CACHE);
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }
	/**
    * 验证缓存数据的有效性
    */
    private isValidCacheData(cache: any): boolean {
        return (
            cache &&
            typeof cache === 'object' &&
            typeof cache.username === 'string' &&
            cache.username.length > 0 &&
            typeof cache.timestamp === 'string' &&
            !isNaN(Date.parse(cache.timestamp))
        );
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
/**
* 扩展状态管理器
* 使用单例模式管理扩展的整体生命周期状态
*/
class ExtensionState {
    private static instance: ExtensionState;
    private _isActivating: boolean = false;
    private _isDeactivating: boolean = false;
    private _activationPromise: Promise<void> | null = null;
    private activationResolve: (() => void) | null = null;

    private constructor() {}

    static getInstance(): ExtensionState {
        if (!this.instance) {
            this.instance = new ExtensionState();
        }
        return this.instance;
    }

    get isActivating(): boolean {
        return this._isActivating;
    }

    get isDeactivating(): boolean {
        return this._isDeactivating;
    }

    async waitForActivation(): Promise<void> {
        if (this._activationPromise) {
            return this._activationPromise;
        }
        return Promise.resolve();
    }

    beginActivation(): void {
        if (this._isActivating) {
            return;
        }
        this._isActivating = true;
        this._activationPromise = new Promise((resolve) => {
            this.activationResolve = resolve;
        });
    }

    completeActivation(): void {
        this._isActivating = false;
        if (this.activationResolve) {
            this.activationResolve();
            this.activationResolve = null;
            this._activationPromise = null;
        }
    }

    beginDeactivation(): void {
        this._isDeactivating = true;
    }

    completeDeactivation(): void {
        this._isDeactivating = false;
    }
}

/**
* 扩展错误类
* 用于统一的错误处理和日志记录
*/
class ExtensionError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly details?: any
    ) {
        super(message);
        this.name = 'ExtensionError';
    }
}


/**
* 扩展控制器
* 负责协调扩展各个组件的初始化和生命周期管理
*/
class ExtensionController {
    private context: vscode.ExtensionContext;
    private themeManager: ThemeManager | null = null;
    private logger: ActionLogger | null = null;
    private userManager: UserManager | null = null;
    private extensionState: ExtensionState;
    private disposables: vscode.Disposable[] = [];

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.extensionState = ExtensionState.getInstance();
    }

    async initialize(): Promise<void> {
        try {
            this.extensionState.beginActivation();

            // 初始化用户管理器
            this.userManager = new UserManager(this.context);
            let userId = await this.userManager.getCachedUsername();

            // 如果没有缓存的用户ID，提示输入
            if (userId === 'undefined') {
                userId = await this.promptForUserId();
            }

            // 初始化日志记录器
            this.logger = new ActionLogger(
                this.context,
                "Themes",
                `${CONFIG.SERVER.PROTOCOL}://${CONFIG.SERVER.HOST}:${CONFIG.SERVER.PORT}${CONFIG.PATHS.LOG}`,
                ['openDocument', 'startDebugSession', 'endDebugSession', 'endTaskProcess', 'saveDocument'], //TODO 这里可以选择是否进行额外的监听功能
                userId
            );

            // 初始化主题管理器
            this.themeManager = new ThemeManager(this.context, this.logger);
            await this.themeManager.initialize();

            // 注册清理
            this.context.subscriptions.push({
                dispose: () => this.dispose()
            });

            // 设置错误处理
            this.setupErrorHandlers();

            this.extensionState.completeActivation();
        } catch (error) {
            this.extensionState.completeActivation();
            throw this.handleError(error);
        }
    }
	/**
    * 提示用户输入ID
    * 包含输入验证和服务器验证
    */
    private async promptForUserId(): Promise<string> {
        const userId = await vscode.window.showInputBox({
            prompt: "Please enter your User ID",
            placeHolder: "User ID",
            ignoreFocusOut: true,
            validateInput: async (value: string) => {
                if (!value || value.trim().length === 0) {
                    return "User ID cannot be empty";
                }
                return null;
            }
        });

        if (!userId) {
            throw new ExtensionError(
                'User ID is required for extension activation',
                'USER_ID_REQUIRED'
            );
        }

        try {
            const isValid = await this.userManager?.validateAndCacheUsername(userId);
            if (!isValid) {
                throw new ExtensionError(
                    'Invalid User ID',
                    'INVALID_USER_ID'
                );
            }
            return userId;
        } catch (error) {
            throw new ExtensionError(
                'Failed to validate User ID',
                'VALIDATION_FAILED',
                error
            );
        }
    }

    /**
    * 设置错误处理器
    * 注册全局的错误捕获和处理机制
    */
	private setupErrorHandlers(): void {
		// 处理未捕获的Promise拒绝
		process.on('unhandledRejection', (reason) => {
			console.error('Unhandled promise rejection:', reason);
			this.handleError(reason);
		});
	
		// 处理未捕获的异常
		process.on('uncaughtException', (error: Error) => {
			console.error('Uncaught exception:', error);
			this.handleError(error);
			
			// 在记录错误后，可能需要优雅地关闭扩展
			this.dispose();
		});
	
		// 添加 VS Code 诊断集合来处理扩展相关的错误
		const diagnosticCollection = vscode.languages.createDiagnosticCollection('mytheme');
		this.disposables.push(diagnosticCollection);
	
		// 监听配置变更错误
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				try {
					if (e.affectsConfiguration('mytheme')) {
						// 处理配置变更
						this.validateConfiguration();
					}
				} catch (error) {
					console.error('Configuration change error:', error);
					this.handleError(error);
				}
			})
		);
	}
	
	// 添加配置验证方法
	private validateConfiguration(): void {
		try {
			const config = vscode.workspace.getConfiguration('mytheme');
			// 在这里添加配置验证逻辑
		} catch (error) {
			throw new ExtensionError(
				'Configuration validation failed',
				'CONFIG_VALIDATION_ERROR',
				error
			);
		}
	}
	/**
    * 错误处理器
    * 统一处理扩展中的各类错误
    * @param error 错误对象
    * 
    * 特点：
    * 1. 错误分类处理
    * 2. 日志记录
    * 3. 用户友好的错误提示
    * 4. 详细的错误信息展示
    */
	private handleError(error: unknown): Error {
		// 改进错误处理以处理不同类型的错误
		let errorMessage: string;
		let errorCode: string;
		let errorStack: string | undefined;
	
		if (error instanceof ExtensionError) {
			errorMessage = error.message;
			errorCode = error.code;
			errorStack = error.stack;
		} else if (error instanceof Error) {
			errorMessage = error.message;
			errorCode = 'UNKNOWN_ERROR';
			errorStack = error.stack;
		} else {
			errorMessage = String(error);
			errorCode = 'UNKNOWN_ERROR';
		}
	
		// 确保 logger 存在
		if (this.logger) {
			this.logger.logAction('error', {
				code: errorCode,
				message: errorMessage,
				stack: errorStack,
				timestamp: new Date().toISOString()
			});
		} else {
			// 如果 logger 不可用，至少记录到控制台
			console.error('Extension error:', {
				code: errorCode,
				message: errorMessage,
				stack: errorStack
			});
		}
	
		// 只在非停用状态下显示错误消息
		if (!this.extensionState.isDeactivating) {
			vscode.window.showErrorMessage(
				`Extension error: ${errorMessage}`,
				'Show Details'
			).then(selection => {
				if (selection === 'Show Details') {
					// 创建并显示错误详情
					const errorChannel = vscode.window.createOutputChannel('MyTheme Error Log');
					errorChannel.appendLine('Error Details:');
					errorChannel.appendLine(`Code: ${errorCode}`);
					errorChannel.appendLine(`Message: ${errorMessage}`);
					if (errorStack) {
						errorChannel.appendLine('Stack Trace:');
						errorChannel.appendLine(errorStack);
					}
					errorChannel.show();
				}
			});
		}
	
		return error instanceof Error ? error : new Error(errorMessage);
	}

   
	/**
    * 资源释放
    * 清理所有扩展资源，确保扩展可以干净地退出
    */
    dispose(): void {
        try {
            this.extensionState.beginDeactivation();
            
            // 清理所有订阅
            this.disposables.forEach(d => d.dispose());
            this.disposables = [];

            // 清理管理器
            if (this.themeManager) {
                this.themeManager.dispose();
                this.themeManager = null;
            }

            if (this.logger) {
                this.logger.dispose();
                this.logger = null;
            }

            this.extensionState.completeDeactivation();
        } catch (error) {
            console.error('Error during extension disposal:', error);
        }
    }
}

/**
* 扩展激活入口点
* @param context 扩展上下文
*/
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const controller = new ExtensionController(context);
    try {
        await controller.initialize();
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to activate extension: ${error}`);
        throw error;
    }
}
/**
* 扩展停用入口点
* 清理工作将由disposables自动处理
*/
export function deactivate(): void {
    // Cleanup will be handled by the disposables
}