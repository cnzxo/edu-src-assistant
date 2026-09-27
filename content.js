// content.js - EDUSRC礼品搜索助手
var added = false;
var cachedData = null;
var searchInput = null;
var searchButton = null;
var statusEl = null;
var debounceTimer = null;
var loadPromise = null;

// ==================== 可兑换判断 ====================
var myGold = null;              // 我的金币余额（来自 /profile/detail/）
var myVulns = null;             // 我的漏洞记录 [{date, school, level}]（来自 /profile/）
var myOrders = null;            // 我的兑换订单 [{date, name, price, status}]（来自 /profile/order/）
var redeemedNames = {};         // 已兑换过的礼品名集合
var giftDetails = {};           // 礼品 id -> {source, price, remain, desc, limitUsed, limitMax}
var onlyRedeemable = false;     // 「只看可兑换」开关状态
var redeemActive = false;       // 是否已激活可兑换功能（激活后才打角标）
var profileLoaded = false;
var profilePromise = null;
var profilePartial = false;     // 漏洞记录是否有页抓取失败（抓不全 → 结果降级为待确认）
var vendorPartial = false;      // 开发商是否超出抓取上限未补全
var expectedVulns = null;       // 页面头部「已审核通过漏洞数量」——权威总数，用于对账
var scanPromise = null;
var redeemToggleEl = null;
var goldEl = null;

var LEVEL_RANK = { '任意': 0, '低危': 1, '中危': 2, '高危': 3 };
var PROFILE_DETAIL_URL = '/profile/detail/';
var PROFILE_URL = '/profile/';
var PROFILE_ORDER_URL = '/profile/order/';

function parseGiftsFromPage(doc) {
    var gifts = [];
    var items = doc.querySelectorAll('ul li');

    items.forEach(function(item) {
        var link = item.querySelector('a');
        var img = item.querySelector('img');

        if (link) {
            var href = link.getAttribute('href');
            var name = link.textContent.trim();
            var giftId = href ? href.match(/\/gift\/(\d+)/) : null;

            var remainText = item.textContent.match(/剩余数量[：:]\s*(\d+)/);
            var priceText = item.textContent.match(/价格[：:]\s*(\d+)/);

            if (name && giftId) {
                gifts.push({
                    id: giftId[1],
                    name: name,
                    url: href,
                    img: img ? img.getAttribute('src') : '',
                    remain: remainText ? parseInt(remainText[1]) : 0,
                    price: priceText ? parseInt(priceText[1]) : 0
                });
            }
        }
    });

    return gifts;
}

function getPageCount(doc) {
    var links = doc.querySelectorAll('a[href*="page="]');
    var maxPage = 1;

    console.log("==> 找到page链接数量:", links.length);

    for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href');
        var match = href.match(/page=(\d+)/);
        if (match) {
            var pageNum = parseInt(match[1]);
            console.log("    href:", href, "-> 页码:", pageNum);
            if (pageNum > maxPage) {
                maxPage = pageNum;
            }
        }
    }

    console.log("==> 最终页数:", maxPage);
    return maxPage;
}

async function loadAllGifts() {
    console.log("==> 开始加载礼品数据...");

    try {
        var response = await fetch(window.location.pathname);
        var html = await response.text();
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, 'text/html');

        var gifts = parseGiftsFromPage(doc);
        var pageCount = getPageCount(doc);

        console.log("==> 总页数:", pageCount, "第一页礼品数:", gifts.length);

        for (var page = 2; page <= pageCount; page++) {
            try {
                var res = await fetch(window.location.pathname + '?page=' + page);
                var h = await res.text();
                var d = parser.parseFromString(h, 'text/html');
                var pageGifts = parseGiftsFromPage(d);
                gifts = gifts.concat(pageGifts);
                console.log("==> 第" + page + "页加载完成,累计:", gifts.length);
            } catch (e) {
                console.log("==> 第" + page + "页加载失败:", e);
            }
        }

        console.log("==> 加载完成，总计:", gifts.length, "条礼品数据");

        cachedData = gifts;
        chrome.storage.local.set({ 'giftCache': gifts }, function() {
            console.log("==>礼品数据已缓存，共", gifts.length, "条");
        });

        return gifts;

    } catch (e) {
        console.log("==> 加载礼品数据失败:", e);
        return [];
    }
}

function fuzzySearch(gifts, keyword) {
    if (!keyword) return gifts;

    var kw = keyword.toLowerCase();
    return gifts.filter(function(gift) {
        return gift.name.toLowerCase().includes(kw);
    });
}

function findThumbnailsContainer() {
    return document.querySelector('.am-avg-sm-4.am-thumbnails');
}

var originalThumbnailsHTML = null;
// 卡片模板只在首次渲染前抓一次：空结果后容器已被换成提示语，再取会把提示当模板
var originalTemplateHTML = null;
var originalTemplateClass = '';

// 分页容器是 .am-pagination（站点没有 .pagination）
function findPagination() {
    return document.querySelector('.am-pagination') ||
        document.querySelector('.pagination') ||
        document.querySelector('ul[class*="pagination"]');
}

// 显示搜索结果到页面
function displayResults(results) {
    var container = findThumbnailsContainer();
    if (!container) {
        console.log("==> 未找到缩略图容器");
        return;
    }

    if (!originalThumbnailsHTML) {
        stripBadges(container);
        originalThumbnailsHTML = container.innerHTML;
    }

    if (originalTemplateHTML === null) {
        stripBadges(container);
        var tpl = container.querySelector('li');
        if (tpl) {
            originalTemplateHTML = tpl.innerHTML;
            originalTemplateClass = tpl.className;
        }
    }

    if (!results.length) {
        container.innerHTML = '<li style="list-style:none; width:100%; padding:24px 0; text-align:center; color:#999; font-size:14px;">' +
            (onlyRedeemable ? '没有可兑换的礼品' : '未找到相关礼品') + '</li>';
        var emptyPagination = findPagination();
        if (emptyPagination) {
            emptyPagination.style.display = 'none';
        }
        return;
    }

    if (originalTemplateHTML === null) {
        console.log("==> 未找到模板li");
        return;
    }

    container.innerHTML = '';

    results.forEach(function(gift) {
        var li = document.createElement('li');
        li.className = originalTemplateClass;
        li.innerHTML = originalTemplateHTML;

        var img = li.querySelector('img');
        if (img) {
            img.src = gift.img;
        }

        var imgLink = li.querySelector('.pic a');
        if (imgLink) {
            imgLink.href = gift.url;
        }

        var links = li.querySelectorAll('a');
        links.forEach(function(link) {
            link.href = gift.url;
        });

        li.innerHTML = li.innerHTML.replace(/原创漏洞证书\s*[^<\s]+[^<]*/, gift.name);
        li.innerHTML = li.innerHTML.replace(/原创漏洞证书-[^<]*/, gift.name);

        var p = li.querySelector('p');
        if (p) {
            p.textContent = '剩余数量： ' + gift.remain + ' | 价格： ' + gift.price;
        }

        container.appendChild(li);
    });

    var pagination = findPagination();
    if (pagination) {
        pagination.style.display = 'none';
    }

    applyRedeemBadges();
}

function restoreOriginalList() {
    if (originalThumbnailsHTML) {
        var container = findThumbnailsContainer();
        if (container) {
            container.innerHTML = originalThumbnailsHTML;
            applyRedeemBadges();
        }
        var pagination = findPagination();
        if (pagination) {
            pagination.style.display = 'block';
        }
    }
}

// 输入防抖：停止输入 250ms 后自动搜索
function onInputChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doLiveSearch, 250);
}

// 确保全量礼品数据已加载（同一时间只加载一次）
function ensureDataLoaded() {
    if (cachedData && cachedData.length) {
        return Promise.resolve(cachedData);
    }
    if (loadPromise) {
        return loadPromise;
    }

    updateStatus('正在加载全部礼品数据…');

    loadPromise = loadAllGifts().then(function(data) {
        cachedData = data || [];
    }).catch(function(e) {
        console.log("==> 数据加载失败:", e);
        cachedData = [];
    }).then(function() {
        loadPromise = null;
        if (!searchInput || !searchInput.value.trim()) {
            updateStatus('');
        }
        return cachedData;
    });

    return loadPromise;
}

// 实时搜索：输入即筛选，无需点击
async function doLiveSearch() {
    if (!searchInput) return;

    var keyword = searchInput.value.trim();

    if (!keyword && !onlyRedeemable) {
        restoreOriginalList();
        updateStatus('');
        return;
    }

    var data = await ensureDataLoaded();

    keyword = searchInput.value.trim();
    if (!keyword && !onlyRedeemable) {
        restoreOriginalList();
        updateStatus('');
        return;
    }

    var results = fuzzySearch(data, keyword);

    // 「只看可兑换」：yes=全满足，maybe=硬性条件满足但含无法自动核验的条款
    if (onlyRedeemable) {
        results = results.filter(function (g) {
            var s = checkGift(g).status;
            return s === 'yes' || s === 'maybe';
        });
    }

    console.log("==> 搜索'" + keyword + "'，找到" + results.length + "条结果" +
        (onlyRedeemable ? "（已过滤不可兑换）" : ""));
    displayResults(results);
    var msg = '找到 ' + results.length + ' 条结果' + (onlyRedeemable ? '（仅可兑换）' : '');
    // 漏洞记录没抓全时提示：待确认的证书可能其实是能兑的
    if (onlyRedeemable && profilePartial) {
        msg += '　⚠️ 漏洞记录未抓全（页面统计 ' + expectedVulns + ' 条，实抓 ' +
            ((myVulns || []).length) + ' 条），标「数据不全」的需自行核对';
    }
    updateStatus(msg);
}

function updateStatus(text) {
    if (statusEl) {
        statusEl.textContent = text || '';
    }
}

// 添加搜索框（站点原生风格，只在标题后插入一次）
function addSearchBox() {
    if (added) return;

    var container = findThumbnailsContainer();
    if (!container) {
        console.log("==> 当前页面无缩略图容器，不添加搜索框");
        return;
    }

    var title = document.querySelector('h2');
    if (!title) {
        console.log("==> 未找到标题，暂不添加搜索框");
        return;
    }

    // z-index：首屏证书列表会短暂上移压住搜索框
    var wrapper = document.createElement('span');
    wrapper.id = 'gift-search-wrapper';
    wrapper.style.cssText = 'position: relative; z-index: 50; display: inline-flex; align-items: center; vertical-align: middle; margin-left: 12px;';

    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'gift-search-input';
    searchInput.placeholder = '输入关键词，实时筛选礼品…';
    searchInput.autocomplete = 'off';
    searchInput.style.cssText = 'box-sizing: border-box; height: 34px; width: 220px; padding: 0 12px; font-size: 13px; color: #333; background: #fff; border: 1px solid #ccc; border-right: none; border-radius: 3px 0 0 3px; outline: none; transition: border-color 0.2s ease;';
    searchInput.addEventListener('focus', function() {
        this.style.borderColor = '#0e90d2';
    });
    searchInput.addEventListener('blur', function() {
        this.style.borderColor = '#ccc';
    });

    searchButton = document.createElement('button');
    searchButton.type = 'button';
    searchButton.id = 'gift-search-btn';
    searchButton.style.cssText = 'box-sizing: border-box; display: inline-flex; align-items: center; gap: 5px; height: 34px; padding: 0 14px; font-size: 13px; color: #fff; background: #0e90d2; border: 1px solid #0e90d2; border-radius: 0 3px 3px 0; cursor: pointer; transition: background 0.2s ease;';
    searchButton.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg><span>搜索</span>';
    searchButton.addEventListener('mouseover', function() {
        this.style.background = '#0a7ab8';
        this.style.borderColor = '#0a7ab8';
    });
    searchButton.addEventListener('mouseout', function() {
        this.style.background = '#0e90d2';
        this.style.borderColor = '#0e90d2';
    });

    statusEl = document.createElement('span');
    statusEl.id = 'gift-search-status';
    statusEl.style.cssText = 'margin-left: 10px; font-size: 12px; color: #888; vertical-align: middle;';

    redeemToggleEl = document.createElement('button');
    redeemToggleEl.type = 'button';
    redeemToggleEl.id = 'gift-redeem-toggle';
    redeemToggleEl.style.cssText = 'box-sizing: border-box; display: inline-flex; align-items: center; height: 34px; padding: 0 12px; margin-left: 8px; font-size: 13px; color: #555; background: #fff; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; transition: background 0.2s ease, color 0.2s ease; vertical-align: middle;';
    redeemToggleEl.textContent = '只看可兑换';
    redeemToggleEl.title = '读取你的金币和漏洞记录，标出可以兑换的礼品';
    redeemToggleEl.addEventListener('click', onToggleRedeemable);

    goldEl = document.createElement('span');
    goldEl.id = 'gift-gold';
    goldEl.style.cssText = 'margin-left: 10px; font-size: 12px; color: #888; vertical-align: middle;';

    searchInput.addEventListener('input', onInputChange);
    searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            clearTimeout(debounceTimer);
            doLiveSearch();
        }
        if (e.key === 'Escape') {
            this.value = '';
            restoreOriginalList();
            updateStatus('');
        }
    });

    searchButton.addEventListener('click', function() {
        clearTimeout(debounceTimer);
        doLiveSearch();
    });

    wrapper.appendChild(searchInput);
    wrapper.appendChild(searchButton);
    wrapper.appendChild(redeemToggleEl);
    wrapper.appendChild(statusEl);
    wrapper.appendChild(goldEl);
    title.insertAdjacentElement('afterend', wrapper);

    added = true;
}

// ==================== 可兑换：数据抓取与解析 ====================

// 同源抓取并解析成 DOM
// fetch 对 4xx/5xx 不 reject，必须查 r.ok，否则错误页会被当成「这一页没记录」
function fetchDoc(url) {
    return fetch(url, { credentials: 'same-origin' })
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' @ ' + url);
            return r.text();
        })
        .then(function (html) { return new DOMParser().parseFromString(html, 'text/html'); });
}

// 限流并发池：同时最多 concurrency 个任务，返回结果与 items 一一对应
function runPool(items, concurrency, worker) {
    var results = new Array(items.length);
    var idx = 0;
    var n = Math.max(1, Math.min(concurrency || 3, items.length || 1));
    function next() {
        if (idx >= items.length) return Promise.resolve();
        var i = idx++;
        return Promise.resolve()
            .then(function () { return worker(items[i], i); })
            .then(function (r) { results[i] = r; })
            .catch(function () { results[i] = undefined; })
            .then(next);
    }
    var runners = [];
    for (var k = 0; k < n; k++) runners.push(next());
    return Promise.all(runners).then(function () { return results; });
}

var MAX_PAGES = 80;             // 分页上限，防异常页码
var MAX_VENDOR_FETCH = 150;     // 单次补开发商的上限

// 从 /profile/detail/ 解析金币余额
function parseGoldFromDoc(doc) {
    var nodes = doc.querySelectorAll('div, td, span, li, dt, dd, label, p, strong, b');
    for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.children.length > 0) continue;
        if (el.textContent.trim() !== '金币') continue;

        var sib = el.nextElementSibling;
        while (sib && !/\d/.test(sib.textContent)) sib = sib.nextElementSibling;
        if (sib) {
            var m = sib.textContent.match(/(\d+)/);
            if (m) return parseInt(m[1], 10);
        }
        if (el.parentElement) {
            var pm = el.parentElement.textContent.replace(/\s+/g, ' ').match(/金币[：:\s]*(\d+)/);
            if (pm) return parseInt(pm[1], 10);
        }
    }
    // 策略 2：整页文本兜底（"金币记录""变化后金币数"后面不跟数字，所以首个命中就是余额）
    var t = doc.body ? doc.body.textContent.replace(/\s+/g, ' ') : '';
    var m2 = t.match(/金币\s*[：:]?\s*(\d+)/);
    return m2 ? parseInt(m2[1], 10) : null;
}

// 从 /profile/ 解析我自己的漏洞记录（表头：时间 | 标题 | 等级 | Rank）
function parseVulnsFromDoc(doc) {
    var out = [];
    var rows = doc.querySelectorAll('table tr');
    var header = null;   // 表头列名（按名字定位列，避免列顺序变化导致错位）
    for (var i = 0; i < rows.length; i++) {
        var tds = rows[i].querySelectorAll('td, th');
        if (!tds.length) continue;

        var texts = [];
        for (var k = 0; k < tds.length; k++) {
            texts.push(tds[k].textContent.replace(/\s+/g, '').trim());
        }

        if (texts.indexOf('等级') >= 0 && texts.indexOf('时间') >= 0) {
            header = texts;
            continue;
        }

        if (tds.length < 3) continue;

        var date = tds[0].textContent.trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

        var school, level, rankRaw;
        var postId = null;
        var linkCell = tds[1];

        if (header) {
            var ci = {
                school: header.indexOf('标题') >= 0 ? header.indexOf('标题') : header.indexOf('单位'),
                level: header.indexOf('等级'),
                rank: header.indexOf('Rank')
            };
            if (ci.school >= 0 && tds[ci.school]) linkCell = tds[ci.school];
            school = linkCell.textContent.replace(/\s+/g, ' ').trim();
            level = (ci.level >= 0 && tds[ci.level]) ? tds[ci.level].textContent.trim() : '';
            rankRaw = (ci.rank >= 0 && tds[ci.rank]) ? tds[ci.rank].textContent.match(/(\d+)/) : null;
        } else {
            // 无表头时的位置兜底：必须像「漏洞记录」行才收
            var rowLink = tds[1].querySelector('a[href*="/post/"]') ||
                rows[i].querySelector('a[href*="/post/"]');
            var posLevel = tds[2] ? tds[2].textContent.trim() : '';
            var looksLikeVuln = !!rowLink || LEVEL_RANK[posLevel] != null;
            if (!looksLikeVuln) continue;

            var a0 = tds[1].querySelector('a');
            school = (a0 ? a0.textContent : tds[1].textContent).replace(/\s+/g, ' ').trim();
            level = posLevel;
            rankRaw = tds[3] ? tds[3].textContent.match(/(\d+)/) : null;
        }

        // 漏洞详情链接（/post/<id>/）——厂商证书要靠它拿「开发商」
        var link = linkCell.querySelector('a[href*="/post/"]') || rows[i].querySelector('a[href*="/post/"]');
        if (link) {
            var pm = (link.getAttribute('href') || '').match(/\/post\/(\d+)/);
            if (pm) postId = pm[1];
        }

        if (school) {
            out.push({
                date: date,
                school: school,
                level: level,
                rank: rankRaw ? parseInt(rankRaw[1], 10) : null,
                postId: postId,
                vendor: null        // 由 enrichVulnVendors 从 /post/<id>/ 补全
            });
        }
    }
    return out;
}

// 从 /post/<id>/ 解析漏洞详情（表头：时间 | 单位 | 开发商 | 作者 | 等级 | Rank）
function parsePostDetailDoc(doc) {
    var out = { vendor: '', unit: '', level: '', rank: null };

    var rows = doc.querySelectorAll('table tr');
    var header = null;
    for (var i = 0; i < rows.length; i++) {
        var tds = rows[i].querySelectorAll('td, th');
        if (!tds.length) continue;

        var texts = [];
        for (var k = 0; k < tds.length; k++) {
            texts.push(tds[k].textContent.replace(/\s+/g, '').trim());
        }

        if (texts.indexOf('开发商') >= 0) { header = texts; continue; }
        if (!header) continue;

        function cell(name) {
            var idx = header.indexOf(name);
            if (idx < 0 || !tds[idx]) return '';
            return tds[idx].textContent.replace(/\s+/g, ' ').trim();
        }

        var vendor = cell('开发商');
        if (vendor) {
            out.vendor = vendor;
            out.unit = cell('单位');
            out.level = cell('等级');
            var rk = cell('Rank').match(/(\d+)/);
            out.rank = rk ? parseInt(rk[1], 10) : null;
            return out;
        }
    }

    var v2 = detailField(doc, '开发商');
    if (v2) {
        out.vendor = v2;
        out.unit = detailField(doc, '单位');
    }
    return out;
}

// 开发商名归一化：去掉公司后缀与行业词，留下可比较的核心名
function vendorCore(s) {
    return (s || '').replace(/\s+/g, '')
        .replace(/(股份|责任)?有限(责任)?公司/g, '')
        .replace(/集团|公司|厂|中心|研究院|研究所/g, '')
        .replace(/科技|软件|信息技术|技术|网络|数据|信息|开发|服务|实业|产业|电子|通信/g, '');
}

// 开发商是否属于某厂商（双向包含，容忍「成都依能科技股份有限公司」vs「依能」这类写法）
function vendorMatch(name, core) {
    if (!name || !core) return false;
    var c = vendorCore(name);
    if (!c) return false;
    return c === core || c.indexOf(core) >= 0 || core.indexOf(c) >= 0;
}

function maxPageFromDoc(doc) {
    var links = doc.querySelectorAll('a[href*="page="]');
    var max = 1;
    for (var i = 0; i < links.length; i++) {
        var m = links[i].getAttribute('href').match(/page=(\d+)/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    if (!isFinite(max) || max < 1) max = 1;
    if (max > MAX_PAGES) {
        console.warn('==> 分页数异常（' + max + '），已按上限 ' + MAX_PAGES + ' 页处理');
        max = MAX_PAGES;
    }
    return max;
}

// 读 /profile/ 头部的「已审核通过漏洞数量：N」，用于对账
function parseApprovedCount(doc) {
    var LABEL = '已审核通过漏洞数量';
    var RE = new RegExp(LABEL + '[：:]?\\s*(\\d+)');

    var body = doc.body ? doc.body.textContent.replace(/\s+/g, '') : '';
    var m = body.match(RE);
    if (m) return parseInt(m[1], 10);

    var nodes = doc.querySelectorAll('div, td, span, li, dt, dd, label, p, strong, b');
    for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.children.length > 0) continue;
        if (el.textContent.replace(/\s+/g, '').indexOf(LABEL) < 0) continue;
        var sib = el.nextElementSibling;
        while (sib && !/\d/.test(sib.textContent)) sib = sib.nextElementSibling;
        if (sib) {
            var mm = sib.textContent.match(/(\d+)/);
            if (mm) return parseInt(mm[1], 10);
        }
    }
    return null;
}

// 统一礼品名（订单里的名字和列表里的名字可能有空白差异）
function normName(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}

// 从 /profile/order/ 解析兑换订单（表头：时间 | 商品 | 价格 | 发货）
function parseOrderFromDoc(doc) {
    var out = [];
    var rows = doc.querySelectorAll('table tr');
    var header = null;      // 识别到订单表头后，只认它下面的行
    var headerIdx = -1;
    for (var i = 0; i < rows.length; i++) {
        var tds = rows[i].querySelectorAll('td, th');
        if (!tds.length) continue;

        var texts = [];
        for (var k = 0; k < tds.length; k++) texts.push(tds[k].textContent.replace(/\s+/g, '').trim());

        // 只认含「商品」/「发货」表头下面的行，避免别的表格被误当订单
        if (header === null && (texts.indexOf('商品') >= 0 || texts.indexOf('发货') >= 0)) {
            header = texts;
            headerIdx = i;
            continue;
        }
        if (header === null) continue;
        if (i <= headerIdx) continue;

        var cols = rows[i].querySelectorAll('td');
        if (cols.length < 3) continue;

        var ci = {
            name: header.indexOf('商品') >= 0 ? header.indexOf('商品') : 1,
            price: header.indexOf('价格') >= 0 ? header.indexOf('价格') : 2,
            status: header.indexOf('发货')
        };

        var date = cols[0].textContent.trim();
        if (!/^\d{4}-\d{2}-\d{2}/.test(date)) continue;

        var name = cols[ci.name] ? cols[ci.name].textContent.replace(/\s+/g, ' ').trim() : '';
        var price = cols[ci.price] ? cols[ci.price].textContent.trim() : '';
        var status = (ci.status >= 0 && cols[ci.status]) ? cols[ci.status].textContent.trim() : '';

        if (name) out.push({ date: date, name: name, price: price, status: status });
    }
    return out;
}

// 只读金币（启动时用，1 个请求）
function loadGoldOnly() {
    if (myGold != null) return Promise.resolve(myGold);
    return fetchDoc(PROFILE_DETAIL_URL)
        .then(function (doc) {
            myGold = parseGoldFromDoc(doc);
            console.log('==> 金币余额:', myGold);
            updateGoldUI();
            return myGold;
        })
        .catch(function () { return null; });
}

// 新抓到的漏洞列表里没有开发商信息，把上次缓存过的按 postId 合回来，避免重复请求
function mergeVendorCache(fresh) {
    if (!myVulns || !myVulns.length) return fresh;
    var old = {};
    myVulns.forEach(function (v) { if (v.postId && v.vendor) old[v.postId] = v; });
    if (!Object.keys(old).length) return fresh;
    fresh.forEach(function (v) {
        var o = v.postId ? old[v.postId] : null;
        if (o) v.vendor = o.vendor;
    });
    return fresh;
}

// 补全漏洞的「开发商」：厂商证书按开发商核验，跟「单位」名对不上（仅存在厂商证书时调用）
var vendorTried = {};       // postId -> true（抓过就不再抓）
var vendorPromise = null;

function hasVendorCert() {
    var list = cachedData || [];
    for (var i = 0; i < list.length; i++) {
        var d = giftDetails[list[i].id];
        var src = (d && d.source) || '';
        if (/公司|企业|厂商/.test(src)) return true;
    }
    return false;
}

function enrichVulnVendors(onProgress) {
    if (vendorPromise) return vendorPromise;
    var todo = (myVulns || []).filter(function (v) {
        return v.postId && v.vendor == null && !vendorTried[v.postId];
    });
    if (!todo.length) {
        vendorPartial = (myVulns || []).some(function (v) { return v.postId && v.vendor == null; });
        return Promise.resolve(myVulns);
    }

    // 单次抓取上限，超出部分留到下次调用
    if (todo.length > MAX_VENDOR_FETCH) {
        console.warn('==> 待补全开发商 ' + todo.length + ' 条，超过单次上限 ' + MAX_VENDOR_FETCH +
            '，本次只补前 ' + MAX_VENDOR_FETCH + ' 条（其余留到下次）');
        todo = todo.slice(0, MAX_VENDOR_FETCH);
    }

    var idx = 0, done = 0;
    var total = todo.length;
    var CONCURRENCY = 3;

    function worker() {
        if (idx >= todo.length) return Promise.resolve();
        var v = todo[idx++];
        vendorTried[v.postId] = true;
        return fetchDoc('/post/' + v.postId + '/')
            .then(function (doc) {
                var info = parsePostDetailDoc(doc);
                v.vendor = info.vendor || '';
                        if (info.unit) v.school = info.unit;
                if (info.level) v.level = info.level;
                if (info.rank != null) v.rank = info.rank;
            })
            .catch(function () { v.vendor = null; })   // 失败保持 null，下次会话还会重试
            .then(function () {
                done++;
                if (onProgress) onProgress(done, total);
                return worker();
            });
    }

    var workers = [];
    for (var i = 0; i < Math.min(CONCURRENCY, todo.length); i++) workers.push(worker());

    vendorPromise = Promise.all(workers).then(function () {
        vendorPromise = null;
        var list = myVulns || [];
        var got = list.filter(function (v) { return v.vendor; }).length;
        // 「是否不完整」按实际状态算：还有 postId 但 vendor 仍为 null 的，就是没补全
        vendorPartial = list.some(function (v) { return v.postId && v.vendor == null; });
        console.log('==> 开发商补全完成：', got, '/', list.length, '条取到开发商',
            vendorPartial ? '（仍有未补全，结论将标记为待确认）' : '');
        var sample = list.filter(function (v) { return v.vendor; }).slice(0, 5);
        if (sample.length) console.log('==> 开发商样例:', sample);
        try { chrome.storage.local.set({ 'myVulns': myVulns }); } catch (e) {}
        return myVulns;
    });

    return vendorPromise;
}

// 汇总各页，并和页面头部的「已审核通过漏洞数量」对账；抓少了就标记不完整
function finishVulnFetch(first, expected, rest) {
    expectedVulns = expected;
    var all = first.slice();
    var failedPages = [];
    var emptyPages = [];

    (rest || []).forEach(function (r) {
        if (!r) return;
        if (!r.ok) { failedPages.push(r.page || '?'); return; }
        if (!r.list.length) { emptyPages.push(r.page); return; }
        all = all.concat(r.list);
    });

    if (failedPages.length) console.warn('==> 第 ' + failedPages.join(',') + ' 页抓取失败（网络/HTTP 错误）');
    if (emptyPages.length) console.warn('==> 第 ' + emptyPages.join(',') + ' 页没有解析到记录');

    if (expected != null) {
        if (all.length < expected) {
            console.warn('==> 对账不通过：页面显示已通过 ' + expected + ' 条，实际只抓到 ' +
                all.length + ' 条，少 ' + (expected - all.length) + ' 条 → 标记为不完整');
            profilePartial = true;
        } else if (all.length > expected) {
            console.warn('==> 抓到 ' + all.length + ' 条，多于页面统计的 ' + expected +
                ' 条（可能含未通过审核的记录），按实际抓到的算');
        } else {
            console.log('==> 对账通过：' + all.length + '/' + expected + ' 条，漏洞记录完整');
        }
    } else if (failedPages.length) {
        console.warn('==> 页面没给出漏洞总数，且存在抓取失败的页 → 标记为不完整');
        profilePartial = true;
    }

    return mergeVendorCache(all);
}

// 读取我的金币 + 全部漏洞记录
function loadMyProfile() {
    if (profileLoaded) {
        return Promise.resolve({ gold: myGold, vulns: myVulns });
    }
    if (profilePromise) return profilePromise;

    profilePartial = false;   // 每次重新拉取都从「完整」开始，只有真的出问题才置位

    profilePromise = Promise.all([
        myGold != null
            ? Promise.resolve(myGold)
            : fetchDoc(PROFILE_DETAIL_URL).then(parseGoldFromDoc).catch(function () { return null; }),
        fetchDoc(PROFILE_URL)
            .then(function (doc) {
                var first = parseVulnsFromDoc(doc);
                var expected = parseApprovedCount(doc);
                var maxPage = maxPageFromDoc(doc);

                // 分页链接没识别出来时，用总数兜底推算页数（每页条数 = 第一页条数）
                if (expected != null && first.length) {
                    var needPages = Math.ceil(expected / first.length);
                    if (needPages > maxPage) {
                        console.log('==> 分页链接只显示出 ' + maxPage + ' 页，但按总数 ' +
                            expected + ' / 每页 ' + first.length + ' 条推算需要 ' + needPages + ' 页，按后者抓取');
                        maxPage = Math.min(needPages, MAX_PAGES);
                    }
                }

                console.log('==> 页面显示已通过 ' + (expected == null ? '?' : expected) +
                    ' 条漏洞，共 ' + maxPage + ' 页，第一页 ' + first.length + ' 条');

                if (maxPage <= 1) {
                    return finishVulnFetch(first, expected, []);
                }

                // 第 2..N 页限流并发，避免一次性打爆站点
                var pages = [];
                for (var p = 2; p <= maxPage; p++) pages.push(p);

                return runPool(pages, 3, function (p) {
                    return fetchDoc(PROFILE_URL + '?page=' + p)
                        .then(function (d) { return { ok: true, page: p, list: parseVulnsFromDoc(d) }; })
                        .catch(function (e) {
                            console.warn('==> 第 ' + p + ' 页抓取失败：', e && e.message ? e.message : e);
                            return { ok: false, page: p, list: [] };
                        });
                }).then(function (rest) {
                    return finishVulnFetch(first, expected, rest);
                });
            })
            .catch(function () { return null; }),
        fetchDoc(PROFILE_ORDER_URL)
            .then(parseOrderFromDoc)
            .catch(function () { return null; })
    ]).then(function (res) {
        myGold = res[0];
        myVulns = res[1];
        myOrders = res[2];

        redeemedNames = {};
        if (myOrders && myOrders.length) {
            myOrders.forEach(function (o) { redeemedNames[normName(o.name)] = o; });
        }

        profileLoaded = true;
        profilePromise = null;
        console.log('==> 金币余额:', myGold, '| 我的漏洞记录:', myVulns ? myVulns.length : 0,
            '条' + (expectedVulns != null ? '（页面统计 ' + expectedVulns + ' 条）' : '') +
            ' | 已兑换订单:', myOrders ? myOrders.length : 0, '条');
        if (myVulns && myVulns.length) console.log('==> 记录样例:', myVulns.slice(0, 3));
        if (myOrders && myOrders.length) console.log('==> 订单样例:', myOrders.slice(0, 3));
        updateGoldUI();
        return { gold: myGold, vulns: myVulns, orders: myOrders };
    });

    return profilePromise;
}

// 从 /gift/<id>/ 解析结构化字段
function detailField(doc, label) {
    var cands = doc.querySelectorAll('.am-u-sm-2, dt, th');
    for (var i = 0; i < cands.length; i++) {
        if (cands[i].textContent.trim() !== label) continue;
        var v = cands[i].nextElementSibling;
        if (v) return v.textContent.replace(/\s+/g, ' ').trim();
    }
    return '';
}

function parseGiftDetailDoc(doc, id) {
    var priceRaw = detailField(doc, '价格');
    var remainRaw = detailField(doc, '剩余数量');
    var limitRaw = detailField(doc, '兑换限制');
    var price = (priceRaw.match(/(\d+)/) || [])[1];
    var remain = (remainRaw.match(/(\d+)/) || [])[1];
    // 「兑换限制」形如 1/1，含义是「我已兑 X 次 / 最多兑 Y 次」
    var lm = limitRaw.match(/(\d+)\s*\/\s*(\d+)/);

    return {
        id: id,
        source: detailField(doc, '来源'),
        desc: detailField(doc, '描述'),
        price: price ? parseInt(price, 10) : null,
        remain: remain ? parseInt(remain, 10) : null,
        limitUsed: lm ? parseInt(lm[1], 10) : null,
        limitMax: lm ? parseInt(lm[2], 10) : null
    };
}

// 扫描全部礼品详情页（并发 3，结果缓存）
function scanGiftDetails(onProgress) {
    if (scanPromise) return scanPromise;

    var seen = {};
    var todo = [];
    (cachedData || []).forEach(function (g) {
        if (!g.id || seen[g.id] || giftDetails[g.id]) return;
        seen[g.id] = true;
        todo.push(g);
    });
    if (!todo.length) return Promise.resolve(giftDetails);

    var idx = 0;
    var done = 0;
    var total = todo.length;
    var CONCURRENCY = 3;

    function worker() {
        if (idx >= todo.length) return Promise.resolve();
        var g = todo[idx++];
        return fetchDoc('/gift/' + g.id + '/')
            .then(function (doc) { giftDetails[g.id] = parseGiftDetailDoc(doc, g.id); })
            .catch(function () { giftDetails[g.id] = null; })
            .then(function () {
                done++;
                if (onProgress) onProgress(done, total);
                return worker();
            });
    }

    var workers = [];
    for (var i = 0; i < Math.min(CONCURRENCY, todo.length); i++) workers.push(worker());

    scanPromise = Promise.all(workers).then(function () {
        scanPromise = null;
        try { chrome.storage.local.set({ 'giftDetails': giftDetails }); } catch (e) {}
        console.log('==> 礼品详情扫描完成，已缓存', Object.keys(giftDetails).length, '条');
        return giftDetails;
    });

    return scanPromise;
}

// ==================== 可兑换：条件解析与匹配 ====================

// 中文数字 → 阿拉伯数字（支持 一/两/十/十一/二十五 等）
var CN_DIGIT = {
    '零': 0, '〇': 0, '一': 1, '壹': 1, '两': 2, '二': 2, '贰': 2, '三': 3, '叁': 3,
    '四': 4, '肆': 4, '五': 5, '伍': 5, '六': 6, '陆': 6, '七': 7, '柒': 7,
    '八': 8, '捌': 8, '九': 9, '玖': 9
};

function cnNum(s) {
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (s.length === 1) return CN_DIGIT[s] != null ? CN_DIGIT[s] : null;
    if (s[0] === '十') return 10 + (CN_DIGIT[s[1]] || 0);
    if (s[1] === '十') return (CN_DIGIT[s[0]] || 0) * 10 + (CN_DIGIT[s[2]] || 0);
    return null;
}

// 时间表述归一化：把站上各种写法统一成「YYYY年M月D日」形态，便于统一解析
function normalizeTimeText(s) {
    var t = s;
    t = t.replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    t = t.replace(/(\d{1,2})月份/g, '$1月');
    t = t.replace(/以来/g, '以后');
    t = t.replace(/(\d{4})年(\d{1,2})(?=[及之以后起开]|$)/g, '$1年$2月');
    t = t.replace(/(?:在|于|为|自|从)(\d{2})年/g, function (all, y) {
        return all.replace(y, String(2000 + parseInt(y, 10)));
    });
    return t;
}

// 正则全量匹配，返回 {start, end, m}
function findAll(re, s) {
    var out = [], m;
    re.lastIndex = 0;
    while ((m = re.exec(s)) !== null) {
        out.push({ start: m.index, end: m.index + m[0].length, m: m });
        if (m[0].length === 0) re.lastIndex++;
    }
    return out;
}

function inSpans(pos, spans) {
    for (var i = 0; i < spans.length; i++) {
        if (pos >= spans[i][0] && pos < spans[i][1]) return true;
    }
    return false;
}

var NUM_CHARS = '0-9零〇一壹两二贰三叁四肆五伍六陆七柒八捌九玖十';
// Rank 的各种写法：Rank3 / 3rank / 不低于3分 / 最低Rank为3 / 3分以上
var RANK_PAT = '(?:[Rr]ank\\s*(\\d+)|(\\d+)\\s*[Rr]ank|不低于\\s*(\\d+)\\s*分|最低\\s*[Rr]ank\\s*为\\s*(\\d+)|(\\d+)\\s*分(?:及)?以上)';

function rankFromMatch(m, offset) {
    for (var i = 0; i < 5; i++) {
        if (m[offset + i]) return parseInt(m[offset + i], 10);
    }
    return null;
}

// 把「描述」里的自由文本解析成结构化条件（启发式）
function parseRequirement(desc, source) {
    var d = normalizeTimeText((desc || '').replace(/\s+/g, ''));
    var req = {
        alts: [],          // 条件分支，多条之间是「或」；单条内部 level 与 rank 是「且」
        minLevel: '中危',
        count: 1,
        dateFrom: null,
        dateTo: null,
        thisYear: false,
        school: source || '',
        vendor: '',        // 厂商证书：按漏洞的「开发商」核验，而不是按「单位」
        noCondition: false, // 描述里根本没有漏洞门槛（如「邀请码」）
        unmodeled: [],     // 无法自动判断的约束 → 结果降级为「可能」
        notes: [],         // 提示性说明
        raw: desc || ''
    };

    // ===== 1. 等级条件：「N 个 … 低/中/高危」 =====
    var levelSpecs = [];
    var spans = [];
    findAll(new RegExp('([' + NUM_CHARS + ']+)?个[^。！？!\\n]{0,30}?(低危|中危|高危)', 'g'), d)
        .forEach(function (x) {
            var c = cnNum(x.m[1]) || 1;
            var lv = x.m[2];
            levelSpecs.push({
                count: c, level: lv,
                levelEnd: x.start + x.m[0].lastIndexOf(lv) + lv.length
            });
            spans.push([x.start, x.end]);
        });
    // 没写「N 个」但直接点了等级
    findAll(/(低危|中危|高危)/g, d).forEach(function (x) {
        if (inSpans(x.start, spans)) return;
        levelSpecs.push({ count: 1, level: x.m[1], levelEnd: x.start + 2 });
    });

    // ===== 2. Rank / 分数条件 =====
    var rankSpecs = [];
    var rankSpans = [];
    findAll(new RegExp('([' + NUM_CHARS + ']+)?个[^。！？!\\n]{0,30}?' + RANK_PAT, 'gi'), d)
        .forEach(function (x) {
            var r = rankFromMatch(x.m, 2);
            if (r == null) return;
            rankSpecs.push({ count: cnNum(x.m[1]) || 1, rank: r, start: x.start, used: false });
            rankSpans.push([x.start, x.end]);
        });
    findAll(new RegExp(RANK_PAT, 'gi'), d).forEach(function (x) {
        if (inSpans(x.start, rankSpans)) return;
        var r = rankFromMatch(x.m, 1);
        if (r == null) return;
        rankSpecs.push({ count: 1, rank: r, start: x.start, used: false });
    });

    // ===== 3. 等级 + 紧随其后的 Rank → 同一条要求（「且」关系） =====
    levelSpecs.forEach(function (ls) {
        var tail = d.slice(ls.levelEnd, ls.levelEnd + 18);
        var cut = tail.search(/或|、/);
        var scope = (cut >= 0 ? tail.slice(0, cut) : tail).replace(/^[（(【\[]/, '');
        var mr = new RegExp('^' + RANK_PAT, 'i').exec(scope);
        if (!mr) return;
        var r = rankFromMatch(mr, 1);
        if (r == null) return;
        ls.rank = r;
        rankSpecs.forEach(function (rs) {
            if (!rs.used && Math.abs(rs.start - ls.levelEnd) <= 18) rs.used = true;
        });
    });

    var alts = levelSpecs.map(function (ls) {
        return { count: ls.count, level: ls.level, rank: ls.rank };
    });
    rankSpecs.forEach(function (rs) {
        if (!rs.used) alts.push({ count: rs.count, rank: rs.rank });
    });

    var seenAlt = {};
    req.alts = alts.filter(function (a) {
        var k = a.count + '/' + (a.level || '') + '/' + (a.rank != null ? a.rank : '');
        if (seenAlt[k]) return false;
        seenAlt[k] = true;
        return true;
    });

    // ===== 4. 完全没有等级/分数条件时 =====
    if (!req.alts.length) {
        var cm = d.match(new RegExp('(?:至少|不少于|超过|多于|达到)?([' + NUM_CHARS + ']+)个'));
        var n = cm ? cnNum(cm[1]) : null;
        if (n != null) {
            req.count = n;
            req.alts.push({ count: n, level: '任意' });
            req.notes.push('描述未写等级要求，按「任意等级」核验');
        } else if ((source && d.indexOf(source.replace(/\s+/g, '')) >= 0) ||
            /我校|本校|该校|所属范围|本单位/.test(d)) {
            // 点名了来源院校 = 有隐含门槛（至少 1 个该范围的漏洞）；
            // 不能只凭「漏洞/报告」这类词判断，那可能只是平台名
            req.alts.push({ count: 1, level: '任意' });
            req.notes.push('描述未写等级/数量，按「至少 1 个该范围的漏洞」核验');
        } else {
            req.noCondition = true;
        }
    }

    // ---- 时间窗口 ----
    var range = d.match(/(\d{4})\s*年?\s*[-–—~至]\s*(\d{4})\s*年/);
    if (range) {
        req.dateFrom = range[1] + '-01-01';
        req.dateTo = range[2] + '-12-31';
    } else {
            var t = d.match(/(?:在|于|为|自|从)?(\d{4})年(?:(\d{1,2})月)?(?:(\d{1,2})[日号])?(?:[（(]含[）)])?(?:及|之)?(?:以后|之后|后|起|开始)/);
        if (t) {
            // 必须补全成 YYYY-MM-DD，否则字符串比较会误判（如 "2026-09-30" >= "2025-10" 为真）
            var mo = t[2] ? ('0' + t[2]).slice(-2) : '01';
            var dy = t[3] ? ('0' + t[3]).slice(-2) : '01';
            req.dateFrom = t[1] + '-' + mo + '-' + dy;
        }
    }
    if (/兑换年度内|本年度|当年/.test(d)) {
        var y = String(new Date().getFullYear());
        req.dateFrom = y + '-01-01';
        req.dateTo = y + '-12-31';
        req.thisYear = true;
    }

    // ---- 是否限定院校 ----
    // 默认按「来源」院校核验；描述没点名时只提示，不放宽成「任意院校都算」（会假阳性）
    var src = (source || '').replace(/\s+/g, '');
    if (!src) {
        req.school = '';
        req.unmodeled.push('未识别到院校，无法按院校核验');
    } else if (/公司|企业|厂商/.test(src)) {
        // 厂商证书按「开发商」核验
        req.vendor = src;
        req.school = '';
        req.notes.push('该证书按「开发商」核验：' + src);
    } else {
        req.school = src;
        if (!/我校|本校|所属范围|该校/.test(d) && d.indexOf(src) < 0) {
            req.notes.push('描述未点名院校，已按「' + src + '」的漏洞核验');
        }
    }

    // ---- 无法自动判断的约束 ----
    if (/不同系统|同一系统|同系统|跨系统/.test(d)) {
        req.unmodeled.push('按「系统」维度计数（同一系统只算 1 个）');
    }
    if (new RegExp(RANK_PAT, 'i').test(d) && !req.alts.some(function (a) { return a.rank != null; })) {
        req.unmodeled.push('Rank 门槛未能识别');
    }
    if (/原则上/.test(d)) {
        req.notes.push('描述写的是「原则上」，属软性要求');
    }
    if (/同一漏洞申请证书不超过|重复漏洞不可兑换|不可重复计入/.test(d)) {
        req.notes.push('描述含「重复漏洞不可重复计入」类限制，实际可用漏洞可能少于记录数');
    }

    return req;
}

function matchVulns(req, vulns) {
    var pool = vulns.slice();
    var vendorMissing = false;   // 有漏洞还没取到开发商

    if (req.school) {
        pool = pool.filter(function (v) {
            return v.school === req.school ||
                v.school.indexOf(req.school) >= 0 ||
                req.school.indexOf(v.school) >= 0;
        });
    }

    // 厂商证书按「开发商」筛；厂商自建系统（单位=厂商）也算数
    var vCore = '';
    if (req.vendor) {
        vCore = vendorCore(req.vendor);
        pool = pool.filter(function (v) {
            if (v.vendor == null) vendorMissing = true;
            return vendorMatch(v.vendor, vCore) || vendorMatch(v.school, vCore);
        });
    }

    if (req.dateFrom) pool = pool.filter(function (v) { return v.date >= req.dateFrom; });
    if (req.dateTo) pool = pool.filter(function (v) { return v.date <= req.dateTo; });

    var scope = '';
    if (req.vendor) scope = '（使用「' + req.vendor + '」产品的系统）';
    else if (req.school) scope = '在 ' + req.school;
    if (req.dateFrom && req.dateTo) {
        scope += '（' + req.dateFrom.slice(0, 7) + ' ~ ' + req.dateTo.slice(0, 7) + '）';
    } else if (req.dateFrom) {
        scope += '（' + req.dateFrom.slice(0, 7) + ' 之后）';
    }

    var alts = (req.alts && req.alts.length)
        ? req.alts
        : [{ count: req.count, level: req.minLevel }];

    function altLabel(a) {
        var parts = [];
        if (a.level && a.level !== '任意') parts.push(a.level + '及以上');
        if (a.rank != null) parts.push('Rank' + a.rank + '及以上');
        if (!parts.length) parts.push('任意等级');
        return parts.join('且');
    }

    function altHit(a) {
        // 同一条要求里 level 与 rank 是「且」关系，两个门槛都要过
        var needLv = LEVEL_RANK[a.level] != null ? LEVEL_RANK[a.level] : 0;
        var anyLevel = !a.level || a.level === '任意';
        return pool.filter(function (v) {
            var lv = LEVEL_RANK[v.level];
            if (anyLevel) {
                // 「任意等级」也必须是条有效记录：有等级，或有 Rank
                if (lv == null && v.rank == null) return false;
            } else if ((lv || 0) < needLv) {
                return false;
            }
            if (a.rank != null && (v.rank || 0) < a.rank) return false;
            return true;
        }).length;
    }

    var ok = false;
    var parts = alts.map(function (a) {
        var hit = altHit(a);
        if (hit >= a.count) ok = true;
        return hit + ' 个' + altLabel(a);
    });

    var needText = alts.map(function (a) {
        return a.count + ' 个' + altLabel(a);
    }).join(' 或 ');

    return {
        ok: ok,
        have: parts.join('，'),
        vendorIncomplete: !!req.vendor && (vendorMissing || vendorPartial),  // 仅厂商证书
        profileIncomplete: profilePartial,                                  // 所有按漏洞核验的证书
        reason: ok ? '' : ('需' + scope + '满足 ' + needText + '；你当前 ' + parts.join('，'))
    };
}

function checkGift(gift) {
    var d = giftDetails[gift.id] || null;

    var price = d && d.price != null ? d.price : gift.price;
    var remain = d && d.remain != null ? d.remain : gift.remain;
    var source = d ? d.source : '';

    var redeemedByLimit = !!(d && d.limitMax != null && d.limitMax > 0 &&
        d.limitUsed != null && d.limitUsed >= d.limitMax);
    var order = redeemedNames[normName(gift.name)] || null;
    var redeemed = redeemedByLimit || !!order;

    var reasons = [];   // 明确不满足的项
    var unknown = [];   // 数据缺失、判断不了的项

    if (remain != null && remain <= 0) reasons.push('已无库存');

    if (myGold == null) unknown.push('金币余额未知');
    else if (price != null && myGold < price) reasons.push('金币不足，差 ' + (price - myGold) + ' 个');

    var cond = null;
    var matched = null;
    if (d && d.desc) {
        cond = parseRequirement(d.desc, d.source);
        if (cond.noCondition) {
            // 无漏洞门槛（如「邀请码」），只看金币与库存
        } else if (myVulns == null) {
            unknown.push('漏洞记录未知');
        } else {
            matched = matchVulns(cond, myVulns);
            var incomplete = matched.vendorIncomplete || matched.profileIncomplete;
            if (incomplete) {
                if (profilePartial) {
                    unknown.push('你的漏洞记录未抓全（部分页加载失败），结论不可靠');
                } else if (vendorPartial) {
                    unknown.push('漏洞较多，开发商未全部补全，无法完全按厂商核验');
                } else {
                    unknown.push('部分漏洞的「开发商」尚未取到，无法按厂商核验');
                }
            }
            if (!matched.ok) {
                // 数据不全时「没匹配到」不能当成「不满足」，否则会漏掉能兑的证书
                if (incomplete) {
                    unknown.push('按现有记录未匹配到，但数据不完整，需点进详情页人工确认：' + matched.reason);
                } else {
                    reasons.push(matched.reason);
                }
            }
        }
    } else {
        unknown.push('兑换条件未获取');
    }

    var status;
    if (redeemed) status = 'redeemed';
    else if (reasons.length) status = 'no';
    else if (unknown.length) status = 'unknown';
    else if (cond && cond.unmodeled && cond.unmodeled.length) status = 'maybe';
    else status = 'yes';

    return {
        price: price,
        remain: remain,
        source: source,
        cond: cond,
        matched: matched,
        redeemed: redeemed,
        redeemedByLimit: redeemedByLimit,
        order: order,
        limitUsed: d ? d.limitUsed : null,
        limitMax: d ? d.limitMax : null,
        status: status,
        reasons: reasons,
        unknown: unknown
    };
}

function findGiftById(id) {
    var list = cachedData || [];
    for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
}

// ==================== 可兑换：界面 ====================

var BADGE_STYLE = 'position:absolute;top:6px;right:6px;z-index:20;padding:2px 7px;border-radius:10px;' +
    'font-size:11px;line-height:16px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.2);';

var BADGE_COLOR = {
    yes: 'background:#5eb95e;color:#fff;',
    maybe: 'background:#f0ad4e;color:#fff;',
    no: 'background:#dd514c;color:#fff;',
    redeemed: 'background:#0e90d2;color:#fff;',
    unknown: 'background:#f8f8f8;color:#999;border:1px solid #ddd;'
};

function badgeText(r) {
    if (r.status === 'redeemed') {
        return r.order && r.order.status ? ('🔁 已兑换 · ' + r.order.status) : '🔁 已兑换';
    }
    if (r.status === 'yes') return '✅ 可兑换';
    if (r.status === 'maybe') return '🟡 基本满足';
    if (r.status === 'no') {
        if (r.reasons.length === 1) {
            if (/库存/.test(r.reasons[0])) return '⛔ 无库存';
            if (/金币/.test(r.reasons[0])) return '💰 ' + r.reasons[0];
            return '⚠️ 条件未达成';
        }
        return '⚠️ ' + r.reasons.length + ' 项不满足';
    }
    // 待确认：区分「我这边数据没抓全」和「条款本身无法自动核验」
    var incomplete = (r.unknown || []).some(function (x) {
        return /未抓全|未全部补全|尚未取到|记录未知/.test(x);
    });
    if (incomplete) return '❓ 数据不全';
    return '❓ 待确认';
}

function badgeTitle(r) {
    var lines = [];
    lines.push('价格：' + (r.price != null ? r.price + ' 金币' : '未知') +
        '　剩余：' + (r.remain != null ? r.remain + ' 个' : '未知'));
    lines.push('我的金币：' + (myGold != null ? myGold + ' 个' : '未读取到'));
    if (r.source) lines.push('来源：' + r.source);
    if (r.limitMax != null) lines.push('兑换限制：' + r.limitUsed + '/' + r.limitMax + '（我已兑/最多兑）');

    if (r.redeemed) {
        lines.push('—— 已兑换 ——');
        if (r.order) {
            lines.push('订单：' + r.order.date + '　价格 ' + r.order.price + '　' + r.order.status);
        }
        if (r.redeemedByLimit) lines.push('依据：兑换限制已达上限');
    }

    if (r.cond) {
        lines.push('兑换条件：' + (r.cond.raw || '（空）'));
        if (r.cond.vendor) {
            lines.push('核验范围：漏洞详情里的「开发商」需为 ' + r.cond.vendor + '（只看单位名不算）');
        }
        if (r.cond.noCondition) {
            lines.push('匹配结果：描述里没有漏洞门槛，只需金币与库存满足');
        } else if (r.matched) {
            lines.push('匹配结果：' + (r.matched.ok ? '已满足' : '未满足') + '，你当前 ' + r.matched.have);
        }
        (r.cond.unmodeled || []).forEach(function (x) { lines.push('• 需你自行确认：' + x); });
        (r.cond.notes || []).forEach(function (x) { lines.push('• 注：' + x); });
    }
    r.reasons.forEach(function (x) { lines.push('✗ ' + x); });
    r.unknown.forEach(function (x) { lines.push('? ' + x); });
    if (r.status === 'maybe') lines.push('说明：硬性条件已满足，但含无法自动核验的条款，建议点进详情页确认');
    return lines.join('\n');
}

function stripBadges(root) {
    var bs = root.querySelectorAll('.gift-redeem-badge');
    for (var i = 0; i < bs.length; i++) {
        if (bs[i].parentNode) bs[i].parentNode.removeChild(bs[i]);
    }
}

// 给当前列表里的每张卡片打角标
function applyRedeemBadges() {
    if (!redeemActive) return;

    var container = findThumbnailsContainer();
    if (!container) return;

    var lis = container.querySelectorAll('li');
    for (var i = 0; i < lis.length; i++) {
        var li = lis[i];

        var old = li.querySelector('.gift-redeem-badge');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var a = li.querySelector('a[href*="/gift/"]');
        if (!a) continue;
        var m = a.getAttribute('href').match(/\/gift\/(\d+)/);
        if (!m) continue;

        var gift = findGiftById(m[1]);
        if (!gift) continue;

        var r = checkGift(gift);

        var host = li.querySelector('.pic') || li;
        if (window.getComputedStyle(host).position === 'static') {
            host.style.position = 'relative';
        }

        var badge = document.createElement('span');
        badge.className = 'gift-redeem-badge';
        badge.textContent = badgeText(r);
        badge.title = badgeTitle(r);
        badge.style.cssText = BADGE_STYLE + (BADGE_COLOR[r.status] || '');
        host.appendChild(badge);
    }
}

function updateGoldUI() {
    if (goldEl) goldEl.textContent = myGold != null ? ('金币 ' + myGold) : '';
}

function updateRedeemToggleUI(progress) {
    if (!redeemToggleEl) return;
    if (progress) {
        redeemToggleEl.textContent = '扫描中 ' + progress.done + '/' + progress.total;
        return;
    }
    if (onlyRedeemable) {
        redeemToggleEl.textContent = '✅ 只看可兑换';
        redeemToggleEl.style.background = '#5eb95e';
        redeemToggleEl.style.borderColor = '#5eb95e';
        redeemToggleEl.style.color = '#fff';
    } else {
        redeemToggleEl.textContent = '只看可兑换';
        redeemToggleEl.style.background = '#fff';
        redeemToggleEl.style.borderColor = '#ccc';
        redeemToggleEl.style.color = '#555';
    }
}

function onToggleRedeemable() {
    onlyRedeemable = !onlyRedeemable;
    redeemActive = onlyRedeemable;   // 关掉开关时同时停止打角标
    updateRedeemToggleUI();

    if (!onlyRedeemable) {
        doLiveSearch();
        return;
    }

    updateStatus('正在读取你的金币与漏洞记录…');
    loadMyProfile()
        .then(function () { return ensureDataLoaded(); })
        // 必须先扫礼品详情（拿「来源」），才知道有没有厂商证书
        .then(function () {
            return scanGiftDetails(function (done, total) {
                updateRedeemToggleUI({ done: done, total: total });
            });
        })
        // 存在厂商证书时，才逐个抓漏洞详情的「开发商」
        .then(function () {
            if (!hasVendorCert()) return null;
            updateStatus('正在读取漏洞的开发商信息…');
            return enrichVulnVendors(function (done, total) {
                updateRedeemToggleUI({ done: done, total: total });
            });
        })
        .then(function () {
            updateRedeemToggleUI();
            updateGoldUI();
            doLiveSearch();
        })
        .catch(function (e) {
            console.log('==> 可兑换数据加载失败:', e);
            updateRedeemToggleUI();
            updateStatus('可兑换数据加载失败');
        });
}

addSearchBox();

var observer = new MutationObserver(function() {
    if (!added) {
        addSearchBox();
    }
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});

// 页面加载完成后在后台预加载全量数据，让首次输入即可秒出结果
function schedulePrefetch() {
    var run = function() {
        ensureDataLoaded().then(function(data) {
            console.log("==> 数据就绪，共", data.length, "条");
            if (searchInput && searchInput.value.trim()) {
                doLiveSearch();
            }
        });
    };

    // 等首屏资源（证书图片）加载稳定后再后台预取，避免抢带宽造成首屏卡顿
    if (window.requestIdleCallback) {
        window.requestIdleCallback(run, { timeout: 3000 });
    } else {
        setTimeout(run, 1500);
    }
}

window.addEventListener('load', function() {
    setTimeout(schedulePrefetch, 800);
});

// 启动时：恢复上次扫描的礼品详情与漏洞缓存（含开发商），并读一次金币（只 1 个请求）
window.addEventListener('load', function() {
    setTimeout(function() {
        try {
            chrome.storage.local.get(['giftDetails', 'myVulns'], function(res) {
                if (res && res.giftDetails) {
                    giftDetails = res.giftDetails;
                    console.log('==> 已恢复礼品详情缓存', Object.keys(giftDetails).length, '条');
                }
                if (res && res.myVulns && res.myVulns.length) {
                    myVulns = res.myVulns;
                    myVulns.forEach(function (v) { if (v.postId && v.vendor) vendorTried[v.postId] = true; });
                    console.log('==> 已恢复漏洞缓存', myVulns.length, '条（含开发商',
                        myVulns.filter(function (v) { return v.vendor; }).length, '条）');
                }
            });
        } catch (e) {}
        loadGoldOnly();
    }, 1200);
});