export function enabledModuleFixture(...moduleIds) {
  const enabled = new Set(moduleIds);
  const env = { qaEnabledModules: enabled };
  const assertModule = async (runtime, moduleId) => {
    if (!runtime?.qaEnabledModules?.has(moduleId)) throw new Error(`Module ${moduleId} disabled in test fixture`);
  };
  return {
    env,
    moduleConfig: {
      assertModule,
      async assertAi(runtime, moduleId) {
        await assertModule(runtime, 'ai');
        if (moduleId !== 'ai') await assertModule(runtime, moduleId);
      },
    },
  };
}
