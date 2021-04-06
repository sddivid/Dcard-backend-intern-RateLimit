# Dcard-backend-intern-homework-middleware

## 作業需求：

限制每小時來自同一個 IP 的請求數量不得超過 1000
在 response headers 中加入剩餘的請求數量 (X-RateLimit-Remaining) 以及 rate limit 歸零的時間 (X-RateLimit-Reset)
如果超過限制的話就回傳 429 (Too Many Requests)
可以使用各種資料庫達成

## API Rate Limit 策略
我在此引用 GCP介紹中的[實施速率限制的技術](https://cloud.google.com/solutions/rate-limiting-strategies-techniques#techniques-enforcing-rate-limits
)

通常，比率是隨時間變化的簡單計數。但是，有幾種不同的測量和限制速率的技術，每種都有其自己的用途和含義。

### 令牌桶:
``` 
令牌桶 保持滾動和累積使用預算作為令牌餘額 。該技術認識到並非服務的所有輸入都與請求1：1對應。令牌桶以一定速率添加令牌。發出服務請求時，服務會嘗試提取令牌（減少令牌計數）來滿足請求。如果存儲桶中沒有令牌，則服務已達到其限制並以背壓進行響應。例如，在GraphQL服務中，單個請求可能會導致將多個操作組合成一個結果。這些操作每個都可以使用一個令牌。這樣，服務可以跟踪限制使用所需的容量，而不是將速率限制技術直接與請求聯繫在一起。
```
漏水桶： 
```
漏水桶 類似於令牌桶，但是速率受可以從水桶中滴落或漏出的量限制。該技術認識到系統具有一定程度的有限能力來保留請求，直到服務可以對其進行操作為止。任何多餘的東西都會簡單地溢出邊緣，並被丟棄。緩衝區容量的概念（但不一定使用洩漏桶）也適用於服務附近的組件，例如負載平衡器和磁盤I / O緩衝區。
```
固定窗口：
```
固定窗口限制（例如每小時3,000個請求或每天10個請求）很容易說明，但是隨著可用配額的重置，它們會在窗口的邊緣受到峰值的影響。例如，考慮每小時限制3,000個請求，這仍然允許在每小時的第一分鐘內發出所有3,000個請求的峰值，這可能會使服務不堪重負。
```
滑動窗口：
```
滑動窗口具有固定窗口的優點，但是時間滾動窗口可消除突發現象。諸如Redis之類的系統利用過期的密鑰來促進該技術的發展。
```



## middleware 設計介紹：

由於作業中並無強制限制使用何種策略，
我在此作業中將採用 Sliding window(滑動窗口)的策略，

由於官網中提到以下與許多使用Lua Script 的優點，所以我將採用 js 搭配 Lua Script。
- 減少請求次數 (EVAL)
- 原子操作 （Atomicity of scripts）
- 重複使用scripts）(EVALSHA)

JS 路徑：`src/middlewares/rateLimiter.ts`

Lua Script 路徑：`src/middlewares/plugin/slidingWindow.lua`

```
local ipAddress = KEYS[1]      // 取得 ipAddress
local now = tonumber(ARGV[1])      // 取得現在時間
local window = tonumber(ARGV[2])       // 取得流量限制時間長度（一小時
local limit = tonumber(ARGV[3])      // 取得流量限制的值
local clearBefore = now - window       // 取得 一小時前 時間（Sliding Queuing 起點時間）
redis.call('ZREMRANGEBYSCORE', ipAddress, '-inf' , clearBefore)      // 清除此 IP 在（Sliding Queuing 起點時間）之前產生的 item(請求紀錄)
local amount = redis.call('ZCARD', ipAddress)      // Zcard 用於計算此 IP 集合中 item 的數量(請求紀錄)

if amount < limit then       // 如果沒超過
    redis.call('ZADD', ipAddress, now, now)      // ZADD 用於增加此 IP 的請求紀錄 （時間戳/時間戳）
end

redis.call('EXPIRE', ipAddress, 3600)      // EXPIRE 用於設定IP 集合的到期時間（即可達成超過一小時都沒有紀錄直接清除）
local firstOne = redis.call('ZRANGE', ipAddress, 0,0,'WITHSCORES') //此 IP 位於Sliding Queuing 的最早請求紀錄
local lastOne = redis.call('ZRANGE', ipAddress, -1,-1,'WITHSCORES') //此 IP 位於Sliding Queuing 的最新請求紀錄
local resetTime = redis.call('TTL', KEYS[1])       // 取得設定IP 集合的到期時間
return { limit - amount, resetTime, now - clearBefore, firstOne,lastOne }
```

使用 Node.js 呼叫 Redis (此實作暫時沒有使用到 EVALSHA ，希望截稿前可以導入)

```

export default async (req: Request, res: Response, next: NextFunction) => {
  
  try {
    return redisClient
      .multi()
      .eval(luaScriptText, 1, ipAddress, now, slidingWindowSec, maxCallsPerHour)
      .exec((err: any, result: any[]) => {
        const [[remainingCount, resetTime, difference,firstOne,lastOne ]] = result;
        res.setHeader('X-RateLimit-Limit', 1000);
        res.setHeader('X-RateLimit-Remaining', remainingCount);
        res.setHeader('X-RateLimit-Reset', lastOne[0]-slidingWindowSec);
        res.setHeader('firstOne', firstOne[0]); 
        res.setHeader('lastOne', lastOne[0]);
        if (remainingCount < 1) {
          return res.status(429).json({
            status:` 429 Too Many Requests`,
            body: `${result}:${ipAddress} Not allowed${accessToken}`,
            detail: `Wait ${new Date(lastOne[0]-slidingWindowSec).getSeconds()} seconds, then slow down!`
          });
        }
        logger.info(`[*] <<< ${ip} connecting, remaining ${result}`);
        return next();
      });
  } catch (error) {
    return res.status(500).json({
      'msg': '我拒絕你的連線',
    });
  }
};
```

# 測試環境 [Dcard-backend-intern-codelab](https://github.com/sddivid/Dcard-backend-intern-codelab)
 [Backend](https://github.com/CS6/D4-homework-Backend)

![services](https://github.com/sddivid/Dcard-backend-intern-RateLimit/blob/ff15f07112656e555ad041e8cdcc8ea3831aa281/%E6%88%AA%E5%9C%96%202021-04-05%20%E4%B8%8B%E5%8D%8811.09.03.png)

services:

    haproxy-dcard
    dcarddrawcardfrontend
    dcarddrawcardbackend
    redis-server
    mongo
    jmeter-master
    jmeter-slave-1
    jmeter-slave-2
    jmeter-slave-3


{jmeter_F2E(GUI)}HA => F2E{jmeter_M} => B2E => {Robo3T(GUI),ARDM(GUI)}DB[redis,mongo]



參考
https://tools.ietf.org/id/draft-polli-ratelimit-headers-00.html
https://developer.okta.com/docs/reference/rl-best-practices/
https://tools.ietf.org/id/draft-polli-ratelimit-headers-02.html#name-throttling-window-specified
https://stackoverflow.com/questions/10645994/how-to-format-a-utc-date-as-a-yyyy-mm-dd-hhmmss-string-using-nodejs




實作參考
https://dzone.com/articles/counting-distinct-users-in-real-time-with-redis-us
https://engagor.github.io/blog/2017/05/02/sliding-window-rate-limiter-redis/


衍生 關於 Redis 是沒有原生的 Expiry time for member 事件，無意中看到了 KeyDB ，覺得也不錯。
http://redisdoc.com/expire/index.html
https://dzone.com/articles/subkey-expires-amp-real-time-expire-deletion-imple
https://github.com/EQ-Alpha/KeyDB
