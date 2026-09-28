import { Headphones, Mic, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { useDialer } from '@/hooks/useDialer'
import { cleanDeviceLabel, isBluetoothLabel, preferBuiltIn } from '@/lib/callQuality'

/**
 * Which microphone the call uses, which speaker it plays through, and a warning
 * when that combination is the reason calls sound muffled.
 *
 * Twilio's Device captures whatever the default input was at creation time, so
 * a Bluetooth headset paired after page load is silently ignored. Re-scanning
 * and calling setInputDevice() explicitly is the only reliable fix.
 *
 * The output picker exists for one reason above all: a Bluetooth headset only
 * drops into its muffled call profile when its MICROPHONE is open. Keep it in
 * for listening and take the mic from the laptop, and both sides sound like a
 * phone call instead of a bad one — which needs the two chosen separately.
 */
export function MicPicker({ compact = false }: { compact?: boolean }) {
  const {
    inputDevices, selectedInput, setInputDevice, refreshInputDevices,
    outputDevices, selectedOutput, setOutputDevice, outputSelectionSupported,
  } = useDialer()

  const options = inputDevices.length
    ? inputDevices.map((d) => ({ value: d.deviceId, label: d.label }))
    : [{ value: 'default', label: 'Default microphone' }]

  const current = inputDevices.find((d) => d.deviceId === (selectedInput ?? 'default'))
  const onBluetooth = isBluetoothLabel(current?.label)
  const alternative = inputDevices
    .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    .filter((d) => !isBluetoothLabel(d.label))
    .sort(preferBuiltIn)[0]

  const iconClass = compact ? 'size-3 shrink-0 text-ink-faint' : 'size-3.5 shrink-0 text-ink-faint'

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Mic className={iconClass} aria-label="Microphone" />
        <Select
          value={selectedInput ?? 'default'}
          onValueChange={(value) => void setInputDevice(value)}
          options={options}
          className={compact ? 'h-7 text-xs' : undefined}
        />
        <Button
          variant="ghost"
          size={compact ? 'iconSm' : 'icon'}
          onClick={() => void refreshInputDevices()}
          title="Rescan audio devices"
        >
          <RefreshCw />
        </Button>
      </div>

      {/* Chrome and Edge only. Safari plays wherever the system says. */}
      {outputSelectionSupported && outputDevices.length > 0 && (
        <div className="flex items-center gap-1.5">
          <Headphones className={iconClass} aria-label="Speaker" />
          <Select
            value={selectedOutput ?? 'default'}
            onValueChange={(value) => void setOutputDevice(value)}
            options={outputDevices.map((d) => ({ value: d.deviceId, label: d.label }))}
            className={compact ? 'h-7 text-xs' : undefined}
          />
        </div>
      )}

      {onBluetooth && (
        <div className="rounded-[5px] border border-warn/30 bg-warn/10 px-2 py-1.5 text-[11px] leading-snug text-warn">
          <p>
            {cleanDeviceLabel(current?.label)} as your mic puts the headset in call mode — you
            will both sound muffled.
          </p>
          {alternative && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-auto px-1.5 py-1 text-left text-[11px] text-warn hover:text-ink"
              onClick={() => void setInputDevice(alternative.deviceId)}
            >
              Use {cleanDeviceLabel(alternative.label)} — keep the headset for listening
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
