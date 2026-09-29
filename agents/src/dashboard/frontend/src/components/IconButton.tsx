// SPDX-FileCopyrightText: 2025 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Button, Tooltip } from '@heroui/react';
import type { ComponentProps } from 'react';

type IconButtonProps = Omit<ComponentProps<typeof Button>, 'isIconOnly' | 'aria-label'> & {
  label: string;
};

export default function IconButton({ label, children, variant = 'ghost', ...props }: IconButtonProps) {
  return (
    <Tooltip delay={450}>
      <Button {...props} isIconOnly variant={variant} aria-label={label}>
        {children}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}
