import { useMemo } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type RegionMultiSelectProps = {
  id?: string;
  value: string;
  options?: string[];
  onChange: (value: string) => void;
  placeholder?: string;
};

function splitRegions(value: string): string[] {
  return value
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function RegionMultiSelect({
  id,
  value,
  options = [],
  onChange,
  placeholder = "Select regions",
}: RegionMultiSelectProps) {
  const selectedRegions = useMemo(() => splitRegions(value), [value]);
  const regionOptions = useMemo(
    () =>
      Array.from(
        new Set([...options.flatMap(splitRegions), ...selectedRegions]),
      ).sort((a, b) => a.localeCompare(b)),
    [options, selectedRegions],
  );

  const toggleRegion = (region: string) => {
    const next = selectedRegions.includes(region)
      ? selectedRegions.filter((selected) => selected !== region)
      : [...selectedRegions, region];
    onChange(next.join("/"));
  };

  const clearRegions = () => onChange("");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded="false"
          className="w-full justify-between font-normal"
        >
          <span
            className={cn(
              "truncate",
              selectedRegions.length === 0 && "text-muted-foreground",
            )}
          >
            {selectedRegions.length > 0
              ? selectedRegions.join(" / ")
              : placeholder}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[--radix-popover-trigger-width] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder="Search regions…" />
          <CommandList>
            <CommandEmpty>No matching region.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="inherit token region" onSelect={clearRegions}>
                <Checkbox
                  checked={selectedRegions.length === 0}
                  tabIndex={-1}
                  aria-hidden="true"
                  className="pointer-events-none mr-2"
                />
                Inherit token region
              </CommandItem>
            </CommandGroup>
            {regionOptions.length > 0 && (
              <CommandGroup>
                {regionOptions.map((region) => (
                  <CommandItem
                    key={region}
                    value={region}
                    onSelect={() => toggleRegion(region)}
                  >
                    <Checkbox
                      checked={selectedRegions.includes(region)}
                      tabIndex={-1}
                      aria-hidden="true"
                      className="pointer-events-none mr-2"
                    />
                    {region}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="clear-region-selection"
                onSelect={clearRegions}
              >
                <Check className="mr-2 h-4 w-4 opacity-0" />
                Clear selection
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
