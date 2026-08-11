import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import { getTokenLiveStatus, getCredit, receiveCredit, tokenSplit } from '@/api/controllers/core.ts';
import logger from '@/lib/logger.ts';

function maskToken(token: string): string {
    const value = token.replace(/^Bearer\s+/i, '').split('@').pop() || '';
    const region = /^(us|hk|jp|sg)-/i.exec(value)?.[1]?.toLowerCase();
    return `${region ? `${region}-` : ''}***${value.slice(-4)}`;
}

function requiresBrowserLogin(error: unknown): boolean {
    return /browser identity missing|shark action check reject|login error|token expired|invalid token|登录|登入/i
        .test(error instanceof Error ? error.message : String(error));
}

async function assertBrowserIdentity(token: string): Promise<void> {
    if (!await getTokenLiveStatus(token)) {
        throw new Error('browser identity missing: 网页登录态无效，请重新完成浏览器登录');
    }
}

export default {

    prefix: '/token',

    post: {

        '/check': async (request: Request) => {
            request
                .validate('body.token', _.isString)
            const live = await getTokenLiveStatus(request.body.token);
            return {
                live
            }
        },

        '/points': async (request: Request) => {
            request
                .validate('headers.authorization', _.isString)
            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            const points = await Promise.all(tokens.map(async (token) => {
                try {
                    await assertBrowserIdentity(token);
                    return {
                        token: maskToken(token),
                        points: await getCredit(token)
                    };
                } catch (err) {
                    const error = err instanceof Error ? err.message : String(err);
                    return {
                        token: maskToken(token),
                        points: null,
                        error,
                        requiresBrowserLogin: requiresBrowserLogin(error)
                    };
                }
            }))
            return points;
        },

        '/receive': async (request: Request) => {
            request
                .validate('headers.authorization', _.isString)
            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            const credits = await Promise.all(tokens.map(async (token) => {
                try {
                    // 先确认网页身份，避免匿名/半失效 Session 返回 0 积分后继续
                    // 触发 credit_receive，造成 shark 风控和无意义的重复请求。
                    await assertBrowserIdentity(token);
                    const currentCredit = await getCredit(token);
                    if (currentCredit.totalCredit <= 0) {
                        await receiveCredit(token);
                        const updatedCredit = await getCredit(token);
                        return {
                            token: maskToken(token),
                            credits: updatedCredit,
                            received: true
                        }
                    }
                    return {
                        token: maskToken(token),
                        credits: currentCredit,
                        received: false
                    }
                } catch (err) {
                    logger.warn('收取积分失败:', err);
                    const error = err instanceof Error ? err.message : String(err);
                    return {
                        token: maskToken(token),
                        credits: null,
                        received: false,
                        error,
                        requiresBrowserLogin: requiresBrowserLogin(error)
                    }
                }
            }))
            return credits;
        }

    }

}
