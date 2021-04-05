import * as fs from 'fs';
import * as path from 'path';
import { Request, Response, NextFunction } from 'express';
import { getClientIp } from '../utils/getIpAddress';
import { connectToRedis } from '../databases/RedisConnection';
import logger from '../shared/logger';
// import slidingWindow from './plugin/slidingWindow';

export default async (req: Request, res: Response, next: NextFunction) => {
  // console.log(req, res, next);
  const { ip } = req;
  const redisClient = connectToRedis();
  const ipAddress = getClientIp(req);
  const maxCallsPerHour = 1000;
  const slidingWindowSec = 1 * 60 * 60 * 1000;
  const now = new Date().getTime();
  const accessToken = '1231412414';
  const luaScriptTextFilePath = path.resolve('./src/middlewares/plugin/slidingWindow.lua');
  const luaScriptText = (await fs.promises.readFile(luaScriptTextFilePath)).toString();
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
