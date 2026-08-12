(function initializeMatchaTaiwanProfile(globalScope) {
  'use strict';

  const PROFILE_NAME = 'taiwan';
  const BASE_PRONUNCIATION_OVERRIDES = Object.freeze({
    '垃圾': Object.freeze(['le4', 'se4']),
  });

  function resolveFrontendApi(frontendApi) {
    const api = frontendApi ?? globalScope.MatchaFrontend;
    if (
      typeof api?.createFrontend !== 'function'
      || typeof api?.pronunciationOverridesFromReview !== 'function'
      || typeof api?.contextualRulesFromReview !== 'function'
    ) {
      throw new Error('MatchaTaiwanProfile 需要先載入 MatchaFrontend');
    }
    return api;
  }

  function createConfig(review, frontendApi = null) {
    const api = resolveFrontendApi(frontendApi);
    return {
      pronunciationOverrides: {
        ...Object.fromEntries(Object.entries(BASE_PRONUNCIATION_OVERRIDES)
          .map(([pattern, phones]) => [pattern, [...phones]])),
        ...api.pronunciationOverridesFromReview(review, PROFILE_NAME),
      },
      contextualRules: api.contextualRulesFromReview(review, PROFILE_NAME),
    };
  }

  function createFrontend({review, frontendApi = null, ...options}) {
    const api = resolveFrontendApi(frontendApi);
    return api.createFrontend({...options, ...createConfig(review, api)});
  }

  const profileApi = {
    profileName: PROFILE_NAME,
    createConfig,
    createFrontend,
  };
  globalScope.MatchaTaiwanProfile = profileApi;
  if (typeof module !== 'undefined' && module.exports) module.exports = profileApi;
}(typeof globalThis !== 'undefined' ? globalThis : self));
