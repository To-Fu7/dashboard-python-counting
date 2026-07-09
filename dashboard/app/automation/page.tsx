export default function AutomationPage() {
  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-border">
        <h1 className="text-2xl font-semibold">Automation</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Node-RED — build custom flows from MQTT events (APD, fire/smoke, face) to alerts,
          webhooks, or anything else in its node ecosystem.
        </p>
      </div>
      <iframe
        src="/nodered"
        title="Automation (Node-RED)"
        className="flex-1 w-full border-0"
      />
    </div>
  );
}
