const downloadApi = require('./jsons/mocked_import_api.json');
const nock = require('nock');

module.exports = {
  addDownloaderMocks: () => {
    // Mock the mlexport endpoint
    nock('https://bots.kore.ai')
      .post('/api/public/bot/mockedBotId/mlexport?state=configured&=&type=json')
      .reply(200, {
        streamId: 'mockedStreamId',
      });

    // Mock the mlexport status endpoint
    const responses = [
      [500], // Simulate an error for the first status check
      [200, { status: 'SOMETHING_ELSE_AS_SUCCESS_AND_FAILED' }],
      [200, { status: 'SUCCESS', downloadUrl: 'mockedDownloadUrl' }],
    ];
    nock('https://bots.kore.ai')
      .get('/api/public/bot/mockedStreamId/mlexport/status')
      .times(responses.length) // Ensure it matches the number of responses
      .reply(() => {
        const res = responses.shift();
        return res;
      });

    // Mock the download URL
    nock('https://bots.kore.ai')
      .get('/mockedDownloadUrl')
      .reply(200, downloadApi);
  },
};