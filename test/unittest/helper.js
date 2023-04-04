const downloadApi = require('./jsons/mocked_import_api.json')

module.exports = {
  addDownloaderMocks: (mockAdapter) => {
    mockAdapter.onPost('https://bots.kore.ai/api/public/bot/mockedBotId/mlexport?state=configured&=&type=json')
      .reply(() => {
        return [200, {
          streamId: 'mockedStreamId'
        }]
      })

    const responses = [
      [[500]], // they had some trouble with status check coming too fast.
      [[200], { status: 'SOMETHING_ELSE_AS_SUCCESS_AND_FAILED' }],
      [[200], { status: 'SUCCESS', downloadUrl: 'mockedDownloadUrl' }]
    ]
    mockAdapter.onGet('https://bots.kore.ai/api/public/bot/mockedStreamId/mlexport/status')
      .reply(() => {
        const res = responses.shift()
        return res
      })

    mockAdapter.onGet('mockedDownloadUrl')
      .replyOnce([200], downloadApi)
  }
}
