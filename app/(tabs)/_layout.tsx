import { Tabs } from "expo-router";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: "none" },
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="conversation" />
      <Tabs.Screen name="memories" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}
