const imageModels = [
    'jimeng-5.0',
    'jimeng-4.6',
    'jimeng-4.5',
    'jimeng-4.1',
    'jimeng-4.0',
    'jimeng-3.1',
    'jimeng-3.0',
    'nanobanana',
    'nanobananapro'
];

const videoModels = [
    'jimeng-video-seedance-2.0',
    'jimeng-video-seedance-2.0-fast',
    'jimeng-video-3.5-pro',
    'jimeng-video-veo3',
    'jimeng-video-veo3.1',
    'jimeng-video-sora2',
    'jimeng-video-3.0-pro',
    'jimeng-video-3.0',
    'jimeng-video-3.0-fast',
    'jimeng-video-2.0-pro',
    'jimeng-video-2.0'
];

export default {
    prefix: '/v1',
    get: {
        '/models': async () => ({
            object: 'list',
            data: [
                ...imageModels.map((id) => ({
                    id,
                    object: 'model',
                    owned_by: 'jimeng-api',
                    capabilities: ['image_generation', 'image_edit']
                })),
                ...videoModels.map((id) => ({
                    id,
                    object: 'model',
                    owned_by: 'jimeng-api',
                    capabilities: ['video_generation']
                }))
            ]
        })
    }
};
