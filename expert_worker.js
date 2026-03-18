require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealthPlugin = require('puppeteer-extra-plugin-stealth')();
const { fakerKO } = require('@faker-js/faker');

chromium.use(stealthPlugin);

class StateManager {
    constructor() {
        this.unactivatedDir = path.join(__dirname, 'unactivated');
        this.accountsDir = path.join(__dirname, 'Accounts');
        this.ensureDirectories();
    }

    ensureDirectories() {
        [this.unactivatedDir, this.accountsDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    saveUnactivated(email, password) {
        const filePath = path.join(this.unactivatedDir, `${email}.txt`);
        fs.writeFileSync(filePath, `${email}:${password}\n`);
        console.log(`[CHECKPOINT] Неактивированный аккаунт сохранен: ${filePath}`);
    }

    getUnactivatedAccounts() {
        if (!fs.existsSync(this.unactivatedDir)) return [];
        return fs.readdirSync(this.unactivatedDir)
            .filter(f => f.endsWith('.txt'))
            .map(f => {
                const content = fs.readFileSync(path.join(this.unactivatedDir, f), 'utf8').trim();
                const [email, password] = content.split(':');
                return { email, password, filePath: path.join(this.unactivatedDir, f) };
            });
    }

    removeUnactivated(filePath) {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[CHECKPOINT] Удален файл: ${filePath}`);
        }
    }

    savePremiumAccount(email, password, tier) {
        const safeTier = tier.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'default';
        const tierDir = path.join(this.accountsDir, safeTier);
        if (!fs.existsSync(tierDir)) {
            fs.mkdirSync(tierDir, { recursive: true });
        }
        const filePath = path.join(tierDir, `${email}.txt`);
        fs.writeFileSync(filePath, `${email}:${password}\n`);
        console.log(`\n🎉 [SUCCESS] Сохранен премиум-аккаунт: ${filePath}\n`);
    }
}

class ProxyManager {
    constructor() {
        this.proxies = [];
        this.currentIndex = 0;
        this.loadProxies();
    }

    loadProxies() {
        const proxyFile = path.join(__dirname, 'proxies.txt');
        try {
            if (fs.existsSync(proxyFile)) {
                const data = fs.readFileSync(proxyFile, 'utf8');
                this.proxies = data.split('\n')
                    .map(l => l.trim())
                    .filter(l => l && !l.startsWith('#'));
                console.log(`[PROXY] Загружено ${this.proxies.length} прокси`);
            }
        } catch (e) {
            console.warn(`[PROXY] Ошибка загрузки прокси: ${e.message}`);
        }
    }

    getNextProxy() {
        if (this.proxies.length === 0) return null;
        const proxy = this.proxies[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
        console.log(`[PROXY] Используется прокси #${this.currentIndex}: ${proxy}`);
        return this.parseProxy(proxy);
    }

    parseProxy(proxyString) {
        const parts = proxyString.split(':');
        if (parts.length === 4) {
            return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
        } else if (parts.length === 2) {
            return { server: `http://${parts[0]}:${parts[1]}` };
        }
        return null;
    }
}

function loadCards(filePath = '../cards.txt') {
    try {
        const data = fs.readFileSync(path.resolve(__dirname, filePath), 'utf8');
        return data.split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'))
            .map(l => { const [num, exp, cvc] = l.split('|'); return { num, exp, cvc }; });
    } catch (e) {
        console.warn(`[WARN] Ошибка загрузки карт: ${e.message}`);
        return [];
    }
}

function loadAddresses(filePath = '../addresses.txt') {
    try {
        const data = fs.readFileSync(path.resolve(__dirname, filePath), 'utf8');
        const blocks = data.split(/\n\s*\n/).filter(b => b.trim());
        return blocks.map(block => {
            const lines = block.split('\n');
            const addr = {};
            lines.forEach(line => {
                const idx = line.indexOf(':');
                if (idx !== -1) {
                    const key = line.substring(0, idx).trim().toLowerCase();
                    const val = line.substring(idx + 1).trim();
                    addr[key] = val;
                }
            });
            return { generateName: () => fakerKO.person.fullName(), address: addr.address || '', city: addr.city || '', state: addr.state || '', zip: addr.zip || '' };
        });
    } catch (e) {
        console.warn(`[WARN] Ошибка загрузки адресов: ${e.message}`);
        return [];
    }
}

function generateKoreanAccount() {
    const pWord = fakerKO.internet.password({ length: 12, pattern: /[A-Za-z0-9]/ }) + 'A1!';
    const fullName = fakerKO.person.fullName();
    const year = 1985 + Math.floor(Math.random() * 15);
    const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
    const day = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
    return { email: null, password: process.env.TEST_PASSWORD || pWord, name: process.env.TEST_NAME || fullName, dobConfig: { year: String(year), month: month, day: day } };
}

async function getGeneratorEmail(mailPage) {
    try {
        console.log(`[MAIL] Открываем Generator.email во второй вкладке...`);
        await mailPage.goto('https://generator.email/inbox3/', { waitUntil: 'domcontentloaded' });
        const emailLocator = mailPage.locator('#email_ch_text').first();
        await emailLocator.waitFor({ state: 'visible', timeout: 30000 });
        let email = await emailLocator.innerText();
        return email.trim();
    } catch (e) {
        throw new Error(`Ошибка получения почты Generator.email: ${e.message}`);
    }
}

async function waitForGeneratorVerificationCode(mailPage) {
    console.log(`[OTP] Ожидание кода подтверждения OpenAI в Inbox3 (пулинг)...`);
    const startTime = Date.now();
    const timeout = 120000;
    while (Date.now() - startTime < timeout) {
        try {
            await mailPage.waitForTimeout(3000);
            const isMailArrived = await mailPage.locator('text=/openai/i').or(mailPage.locator('text=/chatgpt/i')).count();
            if (isMailArrived > 0) {
                const link = mailPage.locator('a:has-text("OpenAI")').or(mailPage.locator('div:has-text("OpenAI")')).first();
                if (await link.isVisible().catch(() => false)) {
                    await link.click().catch(() => false);
                    await mailPage.waitForTimeout(2000);
                }
                const bodyText = await mailPage.locator('body').innerText();
                const codeMatch = bodyText.match(/\b(\d{6})\b/);
                if (codeMatch) {
                    console.log(`[OTP] Получен код: ${codeMatch[1]}`);
                    return codeMatch[1];
                }
            }
            console.log('[OTP] Писем от OpenAI пока нет, обновляем страницу generator.email...');
            await mailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => false);
        } catch (e) {
            console.log(`[OTP] Ошибка пулинга вкладки: ${e.message}`);
        }
    }
    throw new Error('Таймаут получения OTP кода');
}

async function fillUniversalDOB(page, year, month, day) {
    console.log(`[DOB] Пробуем заполнить дату: ${year}-${month}-${day}`);
    try {
        await page.keyboard.press('Tab');
        await page.waitForTimeout(500);
        await page.keyboard.press('End');
        for (let i = 0; i < 15; i++) {
            await page.keyboard.press('Backspace');
            await page.keyboard.press('Delete');
        }
        const placeholder = await page.evaluate(() => document.activeElement ? document.activeElement.placeholder : '') || '';
        const inputType = await page.evaluate(() => document.activeElement ? document.activeElement.type : 'text');
        if (inputType === 'date') {
            await page.keyboard.type(`${year}-${month}-${day}`);
        } else {
            let rawString = `${day}${month}${year}`;
            if (placeholder.includes('MM') && placeholder.indexOf('MM') < placeholder.indexOf('DD')) {
                rawString = `${month}${day}${year}`;
            }
            console.log(`[DOB] Вводим цифры: ${rawString}`);
            for (const char of rawString) {
                await page.keyboard.press(char, { delay: 150 });
            }
        }
    } catch (e) {
        console.log(`[DOB] Ошибка при вводе даты: ${e.message}`);
    }
}

async function detectAndAwaitCaptcha(page) {
    const isCaptchaUrl = page.url().includes('challenge') || page.url().includes('captcha');
    const hasCaptchaElement = await page.locator('iframe[src*="turnstile"], iframe[src*="hcaptcha"], iframe[src*="arkose"], #cf-turnstile').count() > 0;
    if (isCaptchaUrl || hasCaptchaElement) {
        process.stdout.write('\x07');
        console.log('\n🚨 ОБНАРУЖЕНА КАПЧА 🚨 Решите её вручную.');
        try {
            await page.waitForFunction(() => {
                return !window.location.href.includes('challenge') && !window.location.href.includes('captcha');
            }, { timeout: 300000 });
        } catch (e) { }
        console.log('[CAPTCHA] Капча пройдена!');
        await page.waitForTimeout(3000);
        return true;
    }
    return false;
}

async function handlePaymentCheckout(page, card, address) {
    console.log(`\n[CHECKOUT] Обработка платежа для карты: ${card.num}`);
    try {
        const freeOfferBtn = page.locator('button:has-text("Get free offer"), button:has-text("Бесплатное предложение")').first();
        if (await freeOfferBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('[CHECKOUT] Найдена кнопка "Get free offer", кликаем...');
            await freeOfferBtn.click();
            await page.waitForTimeout(2000);
        }
        const stripeFrame = page.frameLocator('iframe[name*="__privateStripeFrame"], iframe[title*="Stripe"], iframe[src*="js.stripe.com"]').first();
        const cardField = stripeFrame.locator('input[name="cardnumber"], input[placeholder*="1234"]').first();
        await cardField.waitFor({ state: 'visible', timeout: 10000 });
        await cardField.fill(card.num, { delay: 50 });
        const expField = stripeFrame.locator('input[name="exp-date"], input[placeholder*="MM"]').first();
        await expField.fill(card.exp, { delay: 50 });
        const cvcField = stripeFrame.locator('input[name="cvc"], input[placeholder*="CVC"]').first();
        await cvcField.fill(card.cvc, { delay: 50 });
        const nameField = page.locator('input[name="cardholder"], input[name="billingName"]').first();
        if (await nameField.isVisible({ timeout: 5000 }).catch(() => false)) {
            await nameField.fill(address.generateName(), { delay: 50 });
        }
        const addressField = page.locator('input[name="address"], input[placeholder*="Address"]').first();
        if (await addressField.isVisible({ timeout: 5000 }).catch(() => false)) {
            await addressField.fill(address.address, { delay: 50 });
        }
        const cityField = page.locator('input[name="city"], input[placeholder*="City"]').first();
        if (await cityField.isVisible({ timeout: 5000 }).catch(() => false)) {
            await cityField.fill(address.city, { delay: 50 });
        }
        const zipField = page.locator('input[name="zip"], input[name="postal"], input[placeholder*="ZIP"]').first();
        if (await zipField.isVisible({ timeout: 5000 }).catch(() => false)) {
            await zipField.fill(address.zip, { delay: 50 });
        }
        const submitBtn = page.locator('button[type="submit"]:has-text("Subscribe"), button:has-text("Pay"), button:has-text("Оплатить")').first();
        await submitBtn.waitFor({ state: 'visible', timeout: 10000 });
        await submitBtn.click();
        const result = await Promise.race([
            page.waitForSelector('.success-message, [data-testid="payment-success"], text=/success|успешно/i', { timeout: 30000 }).then(() => 'success'),
            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).then(() => 'success'),
            page.waitForSelector('.decline-error, span:has-text("declined"), text=/declined|отклонено/i', { timeout: 30000 }).then(() => 'decline')
        ]).catch(e => 'timeout');
        console.log(`[CHECKOUT] Результат платежа: ${result}`);
        return result === 'success';
    } catch (err) {
        console.log(`[CHECKOUT] Ошибка оплаты: ${err.message}`);
        return false;
    }
}

async function loginExistingAccount(page, mailPage, email, password) {
    console.log(`\n[LOGIN] Переход на логин для ${email}...`);
    try {
        await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded' });
        await detectAndAwaitCaptcha(page);
        console.log(`[LOGIN] Нажимаем Log in...`);
        await page.waitForTimeout(2000);
        const loginBtn = page.getByRole('button', { name: /log in|sign in|вход/i })
            .or(page.getByRole('link', { name: /log in|sign in|вход/i }))
            .first();
        await loginBtn.waitFor({ state: 'visible', timeout: 15000 });
        await loginBtn.click();
        console.log(`[LOGIN] Вводим Email...`);
        const emailInput = page.locator('input[type="email"], input[autocomplete="username"]').first();
        await emailInput.waitFor({ state: 'visible', timeout: 15000 });
        await emailInput.fill(email, { delay: 50 });
        await emailInput.press('Enter');
        console.log(`[LOGIN] Вводим Пароль...`);
        const passInput = page.locator('input[type="password"]').first();
        await passInput.waitFor({ state: 'visible', timeout: 15000 });
        await passInput.fill(password, { delay: 50 });
        await passInput.press('Enter');
        const codeInput = page.locator('input[inputmode="numeric"]').first();
        const isOTPRequired = await codeInput.isVisible({ timeout: 10000 }).catch(() => false);
        if (isOTPRequired) {
            console.log(`[LOGIN] Требуется OTP код...`);
            const otpCode = await waitForGeneratorVerificationCode(mailPage);
            const inputsCount = await page.locator('input[maxlength="1"], input[inputmode="numeric"]').count();
            if (inputsCount >= 6) {
                for (let i = 0; i < 6; i++) {
                    await page.locator('input[maxlength="1"], input[inputmode="numeric"]').nth(i).fill(otpCode[i]);
                    await page.waitForTimeout(100);
                }
            } else {
                await codeInput.fill(otpCode, { delay: 100 });
            }
            await page.waitForTimeout(500);
        }
        console.log(`[LOGIN] Успешный вход!`);
        await page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => false);
        return true;
    } catch (e) {
        console.error(`[LOGIN] Ошибка логина: ${e.message}`);
        return false;
    }
}

async function runBillingAutomationE2E() {
    const targetTier = process.env.TARGET_TIER || 'Plus';
    console.log(`--- ЗАПУСК BILLING WORKER: ТАРГЕТ ${targetTier} ---\n`);
    const stateManager = new StateManager();
    const proxyManager = new ProxyManager();
    const cards = loadCards();
    const addresses = loadAddresses();
    if (cards.length === 0) return console.log('❌ Нет карт в cards.txt');
    const isHeadless = process.env.HEADLESS === '1';
    let unactivatedAccounts = stateManager.getUnactivatedAccounts();
    let accountToProcess = null;
    if (unactivatedAccounts.length > 0) {
        console.log(`📋 [CHECKPOINT] Найдено ${unactivatedAccounts.length} неактивированных аккаунтов`);
        accountToProcess = unactivatedAccounts[0];
        console.log(`✅ [CHECKPOINT] Используем аккаунт: ${accountToProcess.email}\n`);
    }
    const proxy = proxyManager.getNextProxy();
    const launchOptions = { headless: isHeadless };
    if (proxy) {
        launchOptions.proxy = proxy;
    }
    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext();
    try {
        const mailPage = await context.newPage();
        const page = await context.newPage();
        await page.bringToFront();
        let testAccount;
        let isNewAccount = !accountToProcess;
        if (accountToProcess) {
            testAccount = { email: accountToProcess.email, password: accountToProcess.password, name: 'Existing User', dobConfig: { year: '1990', month: '06', day: '15' } };
            const loginSuccess = await loginExistingAccount(page, mailPage, accountToProcess.email, accountToProcess.password);
            if (!loginSuccess) {
                throw new Error('Ошибка логина в существующий аккаунт');
            }
        } else {
            const generatedEmail = await getGeneratorEmail(mailPage);
            testAccount = generateKoreanAccount();
            testAccount.email = generatedEmail;
            console.log(`\n[IDENT] Профиль: ${testAccount.name}`);
            console.log(`[IDENT] Почта: ${testAccount.email}\n`);
            console.log(`[NAV] Открываем OpenAI (https://chatgpt.com)...`);
            await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded' });
            await detectAndAwaitCaptcha(page);
            console.log(`[AUTH] Нажимаем Sign Up...`);
            await page.waitForTimeout(4000);
            const signUpRegex = /sign up|register|зарегистрироваться|가입하기|회원가입/i;
            const signUpBtn = page.getByTestId('open-register')
                .or(page.getByRole('button', { name: signUpRegex }))
                .or(page.getByRole('link', { name: signUpRegex }))
                .or(page.getByText(signUpRegex)).first();
            await signUpBtn.waitFor({ state: 'visible', timeout: 15000 });
            await signUpBtn.click();
            console.log(`[AUTH] Ожидание загрузки формы ввода Email...`);
            const emailInput = page.locator('input[type="email"], input[name="email"], input#email-input, input[autocomplete="username"]').first();
            await emailInput.waitFor({ state: 'visible', timeout: 30000 });
            console.log(`[AUTH] Вводим Email...`);
            await emailInput.fill(testAccount.email, { delay: 50 });
            await page.waitForTimeout(500);
            await emailInput.press('Enter');
            console.log(`[AUTH] Вводим Пароль...`);
            const passInput = page.locator('input[type="password");
            await passInput.waitFor({ state: 'visible', timeout: 15000 });
            await passInput.fill(testAccount.password, { delay: 50 });
            await page.waitForTimeout(500);
            await passInput.press('Enter');
            console.log(`[AUTH] Ожидание экрана OTP...`);
            const codeInput = page.locator('input[inputmode="numeric"]').first();
            await codeInput.waitFor({ state: 'visible', timeout: 30000 });
            const otpCode = await waitForGeneratorVerificationCode(mailPage);
            const inputsCount = await page.locator('input[maxlength="1"], input[inputmode="numeric"]').count();
            if (inputsCount >= 6) {
                for (let i = 0; i < 6; i++) {
                    await page.locator('input[maxlength="1"], input[inputmode="numeric"]').nth(i).fill(otpCode[i]);
                    await page.waitForTimeout(100);
                }
            } else {
                await codeInput.fill(otpCode, { delay: 100 });
            }
            await page.waitForTimeout(500);
            const otpContinueBtn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Продолжить")').first();
            if (await otpContinueBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await otpContinueBtn.click();
            } else {
                await codeInput.press('Enter').catch(() => false);
            }
            console.log(`[PROFILE] Успешная регистрация! Ввод данных профиля...`);
            const nameInput = page.locator('input[name="fullName"], input[name="name"]').or(page.locator('input:not([type="hidden"])').first()).first();
            await nameInput.waitFor({ state: 'visible', timeout: 30000 });
            await nameInput.click({ clickCount: 3 });
            await nameInput.fill(testAccount.name, { delay: 100 });
            await fillUniversalDOB(page, testAccount.dobConfig.year, testAccount.dobConfig.month, testAccount.dobConfig.day);
            console.log(`[PROFILE] Нажимаем Agree...`);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(3000);
            try {
                await page.waitForFunction(() => !window.location.href.includes('auth.openai.com'), { timeout: 45000 });
            } catch (e) { }
            stateManager.saveUnactivated(testAccount.email, testAccount.password);
        }
        console.log(`[NAV] Переход к оформлению подписки...`);
        const isBusiness = targetTier.toLowerCase().includes('business') || targetTier.toLowerCase().includes('team');
        const isPlus = targetTier.toLowerCase().includes('plus');
        const isPro = targetTier.toLowerCase().includes('pro');
        let checkoutUrl = 'https://chatgpt.com/auth/setup_stripe?plan=plus';
        if (isBusiness) checkoutUrl = 'https://chatgpt.com/team-sign-up';
        if (isPro) checkoutUrl = 'https://chatgpt.com/auth/setup_stripe?plan=pro';
        await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded' });
        await detectAndAwaitCaptcha(page);
        let paymentSuccess = false;
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            const addr = addresses[i % addresses.length];
            try {
                const success = await handlePaymentCheckout(page, card, addr);
                if (success) {
                    paymentSuccess = true;
                    break;
                }
            } catch (err) {
                console.log(`[CHECKOUT] Ошибка с картой #${i + 1}: ${err.message}`);
            }
            await page.waitForTimeout(2000);
        }
        if (paymentSuccess) {
            stateManager.savePremiumAccount(testAccount.email, testAccount.password, targetTier);
            if (accountToProcess) {
                stateManager.removeUnactivated(accountToProcess.filePath);
            }
            console.log(`\n✅ Аккаунт успешно активирован и сохранен!`);
        } else {
            console.log(`\n❌ Не удалось оплатить подписку`);
            if (isNewAccount) {
                console.log(`[CHECKPOINT] Аккаунт остается в очереди неактивированных`);
            }
        }
    } catch (e) {
        console.error(`[CRITICAL] Ошибка скрипта: ${e.message}`);
        if (!accountToProcess && testAccount) {
            stateManager.saveUnactivated(testAccount.email, testAccount.password);
        }
    } finally {
        console.log(`[TEARDOWN] Закрытие браузера...`);
        await browser.close().catch(() => { });
    }
}

if (require.main === module) {
    runBillingAutomationE2E();
}

module.exports = { StateManager, ProxyManager, runBillingAutomationE2E };