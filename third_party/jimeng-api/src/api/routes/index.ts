import Response from '@/lib/response/Response.ts';
import images from "./images.ts";
import ping from "./ping.ts";
import token from './token.js';
import models from './models.ts';
import videos from './videos.ts';

const imageEditAlias = {
    prefix: '/v1/images',
    post: {
        '/edits': (images as any).post['/compositions']
    }
};

export default [
    {
        get: {
            '/': async () => {
                return {
                    service: 'jimeng-api',
                    status: 'running',
                    version: '1.6.3',
                    description: '免费的AI图像和视频生成API服务 - 基于即梦AI的逆向工程实现',
                    documentation: 'https://github.com/iptag/jimeng-api',
                    endpoints: {
                        images: '/v1/images/generations',
                        compositions: '/v1/images/compositions',
                        edits: '/v1/images/edits',
                        videos: '/v1/videos/generations',
                        models: '/v1/models',
                        health: '/healthz'
                    }
                };
            },
            '/healthz': async () => ({
                service: 'jimeng-api',
                status: 'ok',
                version: '1.6.3'
            })
        }
    },
    images,
    imageEditAlias,
    ping,
    token,
    models,
    videos
];
