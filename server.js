import puppeteer from 'puppeteer';
import fs from 'fs';
import express from 'express'; 
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp } from 'firebase/app';
import { getDatabase, ref, update, onValue, set } from 'firebase/database';
import { firebaseConfig, agents } from './config.js';

// --- CONFIGURATION ---
const ADMIN_USERNAME = "admin"; 
const ADMIN_PASSWORD = "password123"; 
const PORT = process.env.PORT || 3000;

// --- SETUP EXPRESS SERVER ---
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(cookieParser());

// --- 1. PUBLIC ROUTES (Login) ---
app.get('/login', (req, res) => {
    if (req.cookies.auth_token === 'valid_session_token') {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        res.cookie('auth_token', 'valid_session_token', { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true });
        res.sendStatus(200);
    } else {
        res.status(401).send('Invalid credentials');
    }
});

// --- 2. AUTHENTICATION MIDDLEWARE ---
const requireAuth = (req, res, next) => {
    if (req.cookies.auth_token === 'valid_session_token') {
        next();
    } else {
        res.redirect('/login');
    }
};

// --- 3. PROTECTED ROUTES ---
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/dashboard.html', requireAuth, (req, res) => {
    res.redirect('/');
});

app.use(express.static(__dirname)); 

app.listen(PORT, () => console.log(`🌍 Server running at http://localhost:${PORT}`));


// --- BOT LOGIC ---
const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

let isRunning = false;        
let selectedAgents = []; 
let currentHourTracker = -1;  
let sessionStartCounts = {}; 
let hourlyStartCounts = {};  
let lastHourCounts = {};     
let lastAdCounts = {};       
let lastActiveTimes = {};    
let agentPermissions = {};   
let agentIdleState = {}; // Tracks if agent is currently marked idle
let sessionLogs = []; // Stores activity logs
let lastQueueAlertLevel = 'NORMAL'; // Tracks queue state: 'NORMAL', 'YELLOW', 'RED'

let globalBrowser = null; 
let mainPage = null; // Keep one page open

function getDhakaTime() {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dhaka', hour: 'numeric', hour12: false });
    const hour24 = parseInt(formatter.format(new Date()));
    const formatH = (h) => {
        const suffix = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        return `${h12} ${suffix}`;
    };
    return { hour24, label: `${formatH(hour24)} - ${formatH((hour24 + 1) % 24)}` };
}

function getFormattedTime() {
    return new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour12: true, hour: '2-digit', minute: '2-digit' });
}

function addLog(agent, msg, type = 'info') {
    const time = getFormattedTime();
    // Add new log to the top
    sessionLogs.unshift({ time, agent, msg, type });
    // Keep only last 100 logs to save memory
    if (sessionLogs.length > 100) sessionLogs.pop();
}

function formatPermissions(permString) {
    if (!permString) return "-";
    const map = { 'Member': 'M', 'Listing fee': 'L', 'General': 'G', 'Manager': 'MGR', 'Fraud': 'FRD', 'Edited': 'E', 'Verification': 'V', 'Email': 'MAIL' };
    return permString.split(' ').map(p => map[p] || p).join(' ');
}

// --- BROWSER MANAGEMENT ---
async function launchBrowser() {
    if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
    
    // Kill zombie browser if exists
    if (globalBrowser) { 
        try { 
            await globalBrowser.close(); 
        } catch(e) {
            console.log("⚠️ Could not close previous browser instance:", e.message);
        } 
    }

    console.log('🚀 Launching Chrome (GUI Mode)...');
    try {
        globalBrowser = await puppeteer.launch({ 
            headless: false,  // GUI mode
            defaultViewport: null, 
            userDataDir: './user_data', 
            protocolTimeout: 60000, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--start-maximized', 
                '--disable-notifications'
            ]
        });
        return globalBrowser;
    } catch (error) {
        console.error("❌ Fatal Error: Could not launch Chrome.", error);
        throw error;
    }
}

async function checkLogin(page) {
    if (fs.existsSync('cookies.json')) {
        try {
            const cookies = JSON.parse(fs.readFileSync('cookies.json'));
            await page.setCookie(...cookies);
        } catch (e) {
            console.warn("⚠️ Could not load cookies.json, proceeding with clean session or userDataDir.");
        }
    }
    
    try {
        await page.goto('https://admin.bikroy.com/search/item', { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (page.url().includes('login')) {
            console.error("❌ Session Expired (Redirected to Login) - Please log in manually in the GUI window!");
        } else {
            console.log("✅ Logged in successfully.");
        }
    } catch (e) {
        console.warn("⚠️ Login check warning:", e.message);
    }
}

async function scrapeQueues(page) {
    try {
        await page.goto('https://admin.bikroy.com/review/email', { waitUntil: 'networkidle2', timeout: 30000 });
        
        const currentUrl = page.url();
        if (currentUrl.includes('login')) {
            console.error("❌ Session Invalid: Redirected to Login Page.");
            return {};
        }

        try { 
            await page.waitForSelector('.review-tabs .review-count', { timeout: 10000 }); 
        } catch(e) {
            console.log(`⚠️ Queue elements missing.`);
        }
        
        const queueData = await page.evaluate(() => {
            const counts = {};
            document.querySelectorAll('.review-tabs .review-count').forEach(span => {
                const type = span.dataset.type;
                const val = span.textContent.trim().replace(/,/g, '');
                const num = parseInt(val, 10);
                if (type && !isNaN(num)) counts[type] = num;
            });
            return counts;
        });
        return queueData;
    } catch (e) { 
        console.error("Queue Error:", e.message);
        return {}; 
    }
}

async function scrapePermissions(page, agentName, agentConfig) {
    if (!agentConfig.permission_url) return "N/A";
    try {
        await page.goto(agentConfig.permission_url, { waitUntil: 'domcontentloaded' });
        const editHref = await page.evaluate(() => document.querySelector('a.ui-btn.is-standard.edit.is-s')?.getAttribute('href'));
        if (!editHref) return "User Not Found";
        await page.goto('https://admin.bikroy.com' + editHref, { waitUntil: 'domcontentloaded' });
        const rawPerms = await page.evaluate(() => {
            const checked = Array.from(document.querySelectorAll('.permissions .ui-checkbox:checked'));
            return checked.map(cb => cb.parentElement.textContent.trim()).join(' ');
        });
        return formatPermissions(rawPerms);
    } catch (e) { return "Error"; }
}

// --- COMMAND HANDLER (Isolated Tab Version) ---
async function runOneOffScan() {
    console.log('⚡ Running One-Off Scan...');
    
    if (!globalBrowser || !globalBrowser.isConnected()) {
        console.log("⚠️ Browser not ready. Relaunching...");
        await launchBrowser();
    }

    let tempPage = null;

    try {
        tempPage = await globalBrowser.newPage();
        const reviewCounts = await scrapeQueues(tempPage);
        await update(ref(db, 'status'), { lastUpdated: Date.now(), reviewCounts });
        console.log('✅ Manual refresh complete.');
    } catch (e) {
        console.error("Manual Refresh Failed:", e.message);
    } finally {
        if (tempPage) {
            try { await tempPage.close(); } catch(e) {}
        }
    }
}

// --- MAIN LOOP ---
async function startBot() {
    try {
        await launchBrowser();
    } catch (e) {
        console.error("Initial launch failed, will retry in loop");
    }

    onValue(ref(db, 'commands'), (snapshot) => {
        const cmd = snapshot.val();
        if (!cmd) return;
        
        if (cmd.action === 'start') {
            console.log('🟢 START COMMAND');
            isRunning = true;
            selectedAgents = cmd.payload && cmd.payload.length > 0 ? cmd.payload : Object.keys(agents);
            
            const now = Date.now();
            // Reset counters
            sessionStartCounts = {}; hourlyStartCounts = {}; lastHourCounts = {}; lastAdCounts = {}; lastActiveTimes = {}; 
            agentIdleState = {};
            lastQueueAlertLevel = 'NORMAL'; // Reset alert state
            
            // Initialize states
            selectedAgents.forEach(name => {
                lastActiveTimes[name] = now;
                agentIdleState[name] = { isIdle: false, idleSince: now };
            });
            
            currentHourTracker = -1; 
            sessionLogs = []; // Reset logs on new session
            addLog('SYSTEM', 'Tracking Started', 'info');
            
        } else if (cmd.action === 'stop') {
            console.log('🔴 STOP COMMAND');
            isRunning = false;
            selectedAgents = [];
            addLog('SYSTEM', 'Tracking Stopped', 'info');
            
        } else if (cmd.action === 'refresh') {
            runOneOffScan(); 
        } else if (cmd.action === 'clearLogs') {
            console.log('🧹 Logs Cleared');
            sessionLogs = [];
            // We update firebase immediately to clear UI
             update(ref(db, 'status'), { sessionLogs: [] });
        }
        set(ref(db, 'commands'), null);
    });

    try {
        const browser = await launchBrowser();
        mainPage = await browser.newPage();
        await checkLogin(mainPage); 
    } catch (e) { console.error("Initial Page Setup Failed:", e.message); }

    let permTimer = 0;

    while (true) {
        try {
            // SELF-HEALING
            if (!globalBrowser || !globalBrowser.isConnected()) {
                console.log('🔄 Browser disconnected. Restarting...');
                await launchBrowser();
                try { if(mainPage && !mainPage.isClosed()) await mainPage.close(); } catch(e){}
                mainPage = await globalBrowser.newPage();
                await checkLogin(mainPage);
            }
            if (!mainPage || mainPage.isClosed()) {
                 if(globalBrowser) mainPage = await globalBrowser.newPage();
                 await checkLogin(mainPage);
            }

            const { hour24, label } = getDhakaTime();
            const now = Date.now();

            await update(ref(db, 'status'), { lastUpdated: now, isRunning: isRunning, timeLabel: label, sessionLogs: sessionLogs });

            if (!isRunning) {
                await new Promise(r => setTimeout(r, 2000)); 
                continue;
            }

            // --- HOURLY LOGIC & LOW PERFORMANCE CHECK ---
            if (currentHourTracker !== hour24) {
                // If it's not the very first run (where tracker is -1)
                if (currentHourTracker !== -1) {
                    for (const name of selectedAgents) {
                        const currentTotal = lastAdCounts[name] || 0;
                        const startOfHour = hourlyStartCounts[name] || currentTotal;
                        const adsLastHour = Math.max(0, currentTotal - startOfHour);
                        
                        lastHourCounts[name] = adsLastHour;
                        hourlyStartCounts[name] = currentTotal;

                        // Check for Low Performance (< 100 ads)
                        if (adsLastHour < 100) {
                            addLog(name, `📉 Low Performance: Only ${adsLastHour} ads last hour.`, 'warning');
                        }
                    }
                } else {
                    // First run initialization
                    for (const name of selectedAgents) {
                        const currentTotal = lastAdCounts[name] || 0;
                        hourlyStartCounts[name] = currentTotal;
                    }
                }
                currentHourTracker = hour24;
            }

            // Scrape Queues
            const reviewCounts = await scrapeQueues(mainPage);

            // --- QUEUE MONITORING LOGIC (STATE BASED) ---
            const redQueues = [];
            let yellowWarning = false;

            // Check Red Thresholds
            if ((reviewCounts['member'] || 0) > 20) redQueues.push('M');
            if ((reviewCounts['listing_fee'] || 0) > 20) redQueues.push('L');
            if ((reviewCounts['general'] || 0) > 250) redQueues.push('G');
            if ((reviewCounts['manager'] || 0) > 100) redQueues.push('MGR');
            if ((reviewCounts['fraud'] || 0) > 70) redQueues.push('FRD');
            if ((reviewCounts['edited'] || 0) > 250) redQueues.push('E');
            if ((reviewCounts['verification'] || 0) > 2000) redQueues.push('V');

            // Check Yellow Thresholds (Only G and E for "Control Portal")
            if (!redQueues.includes('G') && (reviewCounts['general'] || 0) >= 200) yellowWarning = true;
            if (!redQueues.includes('E') && (reviewCounts['edited'] || 0) >= 150) yellowWarning = true;

            // Determine Current Alert Level
            let currentAlertLevel = 'NORMAL';
            if (redQueues.length > 0) {
                currentAlertLevel = 'RED';
            } else if (yellowWarning) {
                currentAlertLevel = 'YELLOW';
            }

            // Check for State Change (Only log if state changed)
            if (currentAlertLevel !== lastQueueAlertLevel) {
                if (currentAlertLevel === 'RED') {
                    addLog('SYSTEM', `Need to clear ${redQueues.join(', ')}`, 'alert');
                } else if (currentAlertLevel === 'YELLOW') {
                    addLog('SYSTEM', 'Need to control the portal', 'warning');
                } else if (currentAlertLevel === 'NORMAL' && lastQueueAlertLevel !== 'NORMAL') {
                    addLog('SYSTEM', 'Queues returned to normal', 'success');
                }
                
                // Update state
                lastQueueAlertLevel = currentAlertLevel;
            }


            // Scrape Permissions (Once per minute for the first run, then logic can vary, keeping simplifed here)
            if (permTimer === 0 || permTimer >= 60) {
                for (const name of selectedAgents) {
                    agentPermissions[name] = await scrapePermissions(mainPage, name, agents[name]);
                }
                permTimer = 1;
            } else { permTimer++; }

            // Scrape Agents & Idle Logic
            const agentData = {};
            for (const name of selectedAgents) {
                const config = agents[name];
                const url = `https://admin.bikroy.com/search/item?submitted=1&search=&event_type_from=&event_type_to=&event_type=&category=&rejection=&location=&admin_user=${config.id}`;
                try {
                    await mainPage.goto(url, { waitUntil: 'domcontentloaded' });
                    const currentTotal = await mainPage.evaluate(() => {
                        const m = document.body.innerText.match(/of ([\d,]+) results/);
                        return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
                    });

                    // Init data if missing
                    if (sessionStartCounts[name] === undefined) sessionStartCounts[name] = currentTotal;
                    if (hourlyStartCounts[name] === undefined) hourlyStartCounts[name] = currentTotal;
                    if (lastAdCounts[name] === undefined) lastAdCounts[name] = currentTotal;
                    if (lastActiveTimes[name] === undefined) lastActiveTimes[name] = now;
                    if (!agentIdleState[name]) agentIdleState[name] = { isIdle: false, idleSince: now };

                    // --- IDLE CHECK LOGIC ---
                    const previousTotal = lastAdCounts[name];
                    
                    if (currentTotal > previousTotal) {
                        // AGENT IS ACTIVE
                        if (agentIdleState[name].isIdle) {
                            // Agent RETURNED from idle
                            const idleStart = agentIdleState[name].idleSince;
                            const durationMins = Math.floor((now - idleStart) / 60000);
                            
                            const startTimeStr = new Date(idleStart).toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute:'2-digit' });
                            const endTimeStr = new Date(now).toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute:'2-digit' });

                            addLog(name, `✅ Back after ${durationMins}m idle (${startTimeStr} - ${endTimeStr})`, 'success');
                            
                            agentIdleState[name].isIdle = false;
                        }
                        
                        lastActiveTimes[name] = now;
                        agentIdleState[name].idleSince = now; // Reset idle timer
                    } else {
                        // AGENT IS INACTIVE
                        const inactiveMs = now - lastActiveTimes[name];
                        const inactiveMins = Math.floor(inactiveMs / 60000);

                        // Mark as idle if > 15 mins
                        if (inactiveMins >= 15 && !agentIdleState[name].isIdle) {
                            agentIdleState[name].isIdle = true;
                            agentIdleState[name].idleSince = lastActiveTimes[name]; // Set start of idle to last known active time
                            addLog(name, `⚠️ Is inactive for ${inactiveMins} mins.`, 'alert');
                        }
                    }

                    lastAdCounts[name] = currentTotal;

                    const thisHourAds = Math.max(0, currentTotal - hourlyStartCounts[name]);
                    const sessionTotal = Math.max(0, currentTotal - sessionStartCounts[name]);

                    agentData[name] = { 
                        totalAds: currentTotal, 
                        thisHourAds,
                        lastHourAds: lastHourCounts[name] || 0,
                        cumulativeNewAds: sessionTotal,
                        lastActiveTime: lastActiveTimes[name],
                        permissions: agentPermissions[name] || "-"
                    };
                } catch (e) {
                    console.error(`Error scraping ${name}:`, e.message);
                }
            }

            // Update Firebase with Logs
            await update(ref(db, 'status'), { 
                lastUpdated: now, 
                isRunning: true, 
                timeLabel: label, 
                agentData: agentData, 
                reviewCounts: reviewCounts,
                sessionLogs: sessionLogs 
            });
            
            // Wait 60s (Auto refresh)
            await new Promise(r => setTimeout(r, 60000));

        } catch (fatal) {
            console.error("🔥 Fatal Loop Error:", fatal.message);
            if (fatal.message && (fatal.message.includes('detached') || fatal.message.includes('closed') || fatal.message.includes('Session'))) {
                globalBrowser = null;
            }
            await new Promise(r => setTimeout(r, 10000)); 
        }
    }
}

startBot();
