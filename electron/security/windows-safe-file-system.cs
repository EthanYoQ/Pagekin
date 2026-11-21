// This helper is deliberately shipped as an extraResource instead of relying on
// Node's path APIs. It opens every component below the supplied root directory
// handle with OBJ_DONT_REPARSE, so a junction/symlink replacement cannot redirect
// a later read, mkdir, list, or atomic replacement outside that root.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]

namespace AiNovelSecureFs {
  public sealed class SecureFsException : Exception {
    public string Code { get; private set; }
    public SecureFsException(string code) : base(code) { Code = code; }
  }

  public sealed class SecureDirectoryEntry {
    public string Name { get; set; }
    public bool IsDirectory { get; set; }
  }

  public static class SecureHandleFileSystem {
    private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
    private const uint OBJ_DONT_REPARSE = 0x00001000;
    private const uint FILE_LIST_DIRECTORY = 0x00000001;
    private const uint FILE_TRAVERSE = 0x00000020;
    private const uint FILE_READ_DATA = 0x00000001;
    private const uint FILE_WRITE_DATA = 0x00000002;
    private const uint FILE_ADD_FILE = 0x00000002;
    private const uint FILE_ADD_SUBDIRECTORY = 0x00000004;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_WRITE_ATTRIBUTES = 0x00000100;
    private const uint DELETE = 0x00010000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint FILE_ATTRIBUTE_READONLY = 0x00000001;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint FILE_DIRECTORY_FILE = 0x00000001;
    private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
    private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
    private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_OPEN = 0x00000001;
    private const uint FILE_CREATE = 0x00000002;
    private const uint FILE_OPEN_IF = 0x00000003;
    private const int FileDirectoryInformation = 1;
    private const int FileRenameInformation = 10;
    private const int FileDispositionInformation = 13;
    private const int STATUS_SUCCESS = 0;
    private const int STATUS_ACCESS_DENIED = unchecked((int)0xC0000022);
    private const int STATUS_SHARING_VIOLATION = unchecked((int)0xC0000043);
    private const int STATUS_BUFFER_OVERFLOW = unchecked((int)0x80000005);
    private const int STATUS_NO_MORE_FILES = unchecked((int)0x80000006);
    private const int STATUS_OBJECT_NAME_NOT_FOUND = unchecked((int)0xC0000034);
    private const int STATUS_OBJECT_PATH_NOT_FOUND = unchecked((int)0xC000003A);
    private const int STATUS_REPARSE_POINT_ENCOUNTERED = unchecked((int)0xC000050B);
    private const int STATUS_REPARSE_POINT_NOT_RESOLVED = unchecked((int)0xC0000280);
    private const int STATUS_DIRECTORY_IS_A_REPARSE_POINT = unchecked((int)0xC0000281);
    private const int MaxTextBytes = 64 * 1024 * 1024;
    private const int MaxSegments = 256;
    private const int MaxEntries = 16384;

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString {
      public ushort Length;
      public ushort MaximumLength;
      public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes {
      public int Length;
      public IntPtr RootDirectory;
      public IntPtr ObjectName;
      public uint Attributes;
      public IntPtr SecurityDescriptor;
      public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock {
      public int Status;
      public IntPtr Information;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation {
      public uint FileAttributes;
      public uint CreationTimeLow;
      public uint CreationTimeHigh;
      public uint LastAccessTimeLow;
      public uint LastAccessTimeHigh;
      public uint LastWriteTimeLow;
      public uint LastWriteTimeHigh;
      public uint VolumeSerialNumber;
      public uint FileSizeHigh;
      public uint FileSizeLow;
      public uint NumberOfLinks;
      public uint FileIndexHigh;
      public uint FileIndexLow;
    }

    public sealed class RootIdentity {
      public readonly uint VolumeSerialNumber;
      public readonly ulong FileIndex;

      public RootIdentity(uint volumeSerialNumber, ulong fileIndex) {
        VolumeSerialNumber = volumeSerialNumber;
        FileIndex = fileIndex;
      }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RenameInformationHeader {
      public byte ReplaceIfExists;
      public IntPtr RootDirectory;
      public uint FileNameLength;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DispositionInformation {
      public byte DeleteFile;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(
      out IntPtr fileHandle,
      uint desiredAccess,
      ref ObjectAttributes objectAttributes,
      out IoStatusBlock ioStatusBlock,
      IntPtr allocationSize,
      uint fileAttributes,
      uint shareAccess,
      uint createDisposition,
      uint createOptions,
      IntPtr eaBuffer,
      uint eaLength);

    [DllImport("ntdll.dll")]
    private static extern int NtClose(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtSetInformationFile(
      IntPtr fileHandle,
      out IoStatusBlock ioStatusBlock,
      IntPtr fileInformation,
      uint length,
      int fileInformationClass);

    [DllImport("ntdll.dll")]
    private static extern int NtWriteFile(
      IntPtr fileHandle,
      IntPtr eventHandle,
      IntPtr apcRoutine,
      IntPtr apcContext,
      out IoStatusBlock ioStatusBlock,
      [In] byte[] buffer,
      uint length,
      IntPtr byteOffset,
      IntPtr key);

    [DllImport("ntdll.dll")]
    private static extern int NtFlushBuffersFile(
      IntPtr fileHandle,
      out IoStatusBlock ioStatusBlock);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryDirectoryFile(
      IntPtr fileHandle,
      IntPtr eventHandle,
      IntPtr apcRoutine,
      IntPtr apcContext,
      out IoStatusBlock ioStatusBlock,
      IntPtr fileInformation,
      uint length,
      int fileInformationClass,
      [MarshalAs(UnmanagedType.U1)] bool returnSingleEntry,
      IntPtr fileName,
      [MarshalAs(UnmanagedType.U1)] bool restartScan);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(
      IntPtr fileHandle,
      out ByHandleFileInformation fileInformation);

    private static bool IsValidHandle(IntPtr handle) {
      return handle != IntPtr.Zero && handle != new IntPtr(-1);
    }

    private static void CloseHandle(ref IntPtr handle) {
      if (IsValidHandle(handle)) NtClose(handle);
      handle = IntPtr.Zero;
    }

    private static void ThrowForStatus(int status) {
      if (status == STATUS_REPARSE_POINT_ENCOUNTERED || status == STATUS_REPARSE_POINT_NOT_RESOLVED || status == STATUS_DIRECTORY_IS_A_REPARSE_POINT) {
        throw new SecureFsException("SECURE_FS_REPARSE_POINT");
      }
      if (status == STATUS_OBJECT_NAME_NOT_FOUND || status == STATUS_OBJECT_PATH_NOT_FOUND) {
        throw new SecureFsException("SECURE_FS_NOT_FOUND");
      }
      throw new SecureFsException("SECURE_FS_OPEN_FAILED");
    }

    public static RootIdentity ParseRootIdentity(string volumeSerialNumber, string fileIndex) {
      ulong volume;
      ulong index;
      if (String.IsNullOrEmpty(volumeSerialNumber) || String.IsNullOrEmpty(fileIndex)
          || !UInt64.TryParse(volumeSerialNumber, NumberStyles.None, CultureInfo.InvariantCulture, out volume)
          || volume > UInt32.MaxValue
          || !UInt64.TryParse(fileIndex, NumberStyles.None, CultureInfo.InvariantCulture, out index)) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
      return new RootIdentity((uint)volume, index);
    }

    private static void VerifyRootIdentity(IntPtr rootHandle, RootIdentity expected) {
      if (expected == null) throw new SecureFsException("SECURE_FS_INVALID_PATH");
      ByHandleFileInformation actual;
      if (!GetFileInformationByHandle(rootHandle, out actual)) {
        throw new SecureFsException("SECURE_FS_OPEN_FAILED");
      }
      ulong fileIndex = ((ulong)actual.FileIndexHigh << 32) | actual.FileIndexLow;
      if (actual.VolumeSerialNumber != expected.VolumeSerialNumber || fileIndex != expected.FileIndex) {
        throw new SecureFsException("SECURE_FS_ROOT_CHANGED");
      }
    }

    private static string ToNtPath(string rootPath) {
      if (String.IsNullOrEmpty(rootPath) || rootPath.IndexOf('\0') >= 0) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
      string full = Path.GetFullPath(rootPath);
      if (full.StartsWith("\\\\?\\", StringComparison.Ordinal)) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
      if (full.StartsWith("\\\\", StringComparison.Ordinal)) {
        return "\\??\\UNC\\" + full.Substring(2);
      }
      if (full.Length >= 3 && Char.IsLetter(full[0]) && full[1] == ':' && (full[2] == '\\' || full[2] == '/')) {
        return "\\??\\" + full;
      }
      throw new SecureFsException("SECURE_FS_INVALID_PATH");
    }

    private static void ValidateSegment(string segment) {
      if (String.IsNullOrEmpty(segment) || segment == "." || segment == ".." || segment.IndexOf('\0') >= 0
        || segment.IndexOf(':') >= 0 || segment.EndsWith(".", StringComparison.Ordinal) || segment.EndsWith(" ", StringComparison.Ordinal)) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
      string bare = segment.Split('.')[0];
      string upper = bare.ToUpperInvariant();
      if (upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL"
        || (upper.StartsWith("COM") && upper.Length == 4 && upper[3] >= '1' && upper[3] <= '9')
        || (upper.StartsWith("LPT") && upper.Length == 4 && upper[3] >= '1' && upper[3] <= '9')) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
    }

    private static string[] RelativeSegments(string relativePath) {
      if (relativePath == null || relativePath.IndexOf('\0') >= 0 || relativePath.StartsWith("\\", StringComparison.Ordinal)
        || relativePath.StartsWith("/", StringComparison.Ordinal)) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
      string[] raw = relativePath.Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries);
      if (raw.Length > MaxSegments) throw new SecureFsException("SECURE_FS_INVALID_PATH");
      foreach (string segment in raw) ValidateSegment(segment);
      return raw;
    }

    private static IntPtr OpenRelative(
      IntPtr rootDirectory,
      string name,
      uint desiredAccess,
      uint fileAttributes,
      uint disposition,
      uint options) {
      return OpenRelative(
        rootDirectory,
        name,
        desiredAccess,
        fileAttributes,
        disposition,
        options,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }

    private static IntPtr OpenRelative(
      IntPtr rootDirectory,
      string name,
      uint desiredAccess,
      uint fileAttributes,
      uint disposition,
      uint options,
      uint shareAccess) {
      return OpenRelative(
        rootDirectory,
        name,
        desiredAccess,
        fileAttributes,
        disposition,
        options,
        shareAccess,
        true);
    }

    private static IntPtr OpenRelative(
      IntPtr rootDirectory,
      string name,
      uint desiredAccess,
      uint fileAttributes,
      uint disposition,
      uint options,
      uint shareAccess,
      bool preventReparse) {
      IntPtr handle;
      int status = CreateRelative(rootDirectory, name, desiredAccess, fileAttributes, disposition, options, shareAccess, preventReparse, out handle);
      if (status != STATUS_SUCCESS) ThrowForStatus(status);
      return handle;
    }

    private static int CreateRelative(
      IntPtr rootDirectory,
      string name,
      uint desiredAccess,
      uint fileAttributes,
      uint disposition,
      uint options,
      uint shareAccess,
      bool preventReparse,
      out IntPtr handle) {
      if (name == null || name.Length > 32760) throw new SecureFsException("SECURE_FS_INVALID_PATH");
      IntPtr nameBuffer = IntPtr.Zero;
      try {
        nameBuffer = Marshal.StringToHGlobalUni(name);
        UnicodeString unicode = new UnicodeString {
          Length = checked((ushort)(name.Length * 2)),
          MaximumLength = checked((ushort)((name.Length * 2) + 2)),
          Buffer = nameBuffer,
        };
        IntPtr unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
        try {
          Marshal.StructureToPtr(unicode, unicodePointer, false);
          uint objectAttributes = OBJ_CASE_INSENSITIVE;
          uint createOptions = options | FILE_SYNCHRONOUS_IO_NONALERT;
          if (preventReparse) {
            objectAttributes |= OBJ_DONT_REPARSE;
            createOptions |= FILE_OPEN_REPARSE_POINT;
          }
          ObjectAttributes attributes = new ObjectAttributes {
            Length = Marshal.SizeOf(typeof(ObjectAttributes)),
            RootDirectory = rootDirectory,
            ObjectName = unicodePointer,
            Attributes = objectAttributes,
            SecurityDescriptor = IntPtr.Zero,
            SecurityQualityOfService = IntPtr.Zero,
          };
          IoStatusBlock ioStatus;
          return NtCreateFile(
            out handle,
            desiredAccess,
            ref attributes,
            out ioStatus,
            IntPtr.Zero,
            fileAttributes,
            shareAccess,
            disposition,
            createOptions,
            IntPtr.Zero,
            0);
        } finally {
          Marshal.FreeHGlobal(unicodePointer);
        }
      } finally {
        if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
      }
    }

    private static uint DirectoryAccess(bool writable) {
      uint access = FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
      if (writable) access |= FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY;
      return access;
    }

    private static IntPtr OpenRoot(string rootPath, RootIdentity rootIdentity, bool writable) {
      // The user-authorized root is bound to a directory handle once. It may
      // legitimately sit below a parent junction, so only this initial,
      // absolute open is allowed to resolve reparse points. All child opens
      // keep OBJ_DONT_REPARSE and FILE_OPEN_REPARSE_POINT via OpenRelative.
      IntPtr root = OpenRelative(
        IntPtr.Zero,
        ToNtPath(rootPath),
        DirectoryAccess(writable),
        FILE_ATTRIBUTE_DIRECTORY,
        FILE_OPEN,
        FILE_DIRECTORY_FILE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        false);
      try {
        VerifyRootIdentity(root, rootIdentity);
        return root;
      } catch {
        CloseHandle(ref root);
        throw;
      }
    }

    private static IntPtr OpenDirectory(IntPtr parent, string segment, bool createIfMissing, bool writable) {
      return OpenRelative(
        parent,
        segment,
        DirectoryAccess(writable),
        FILE_ATTRIBUTE_DIRECTORY,
        createIfMissing ? FILE_OPEN_IF : FILE_OPEN,
        FILE_DIRECTORY_FILE);
    }

    private static IntPtr OpenFile(IntPtr parent, string segment, uint desiredAccess, uint disposition) {
      return OpenRelative(
        parent,
        segment,
        desiredAccess,
        FILE_ATTRIBUTE_NORMAL,
        disposition,
        FILE_NON_DIRECTORY_FILE);
    }

    private static List<IntPtr> OpenDirectoryChain(string rootPath, RootIdentity rootIdentity, string[] segments, bool createIfMissing, bool writable) {
      List<IntPtr> handles = new List<IntPtr>();
      try {
        IntPtr current = OpenRoot(rootPath, rootIdentity, writable);
        handles.Add(current);
        foreach (string segment in segments) {
          current = OpenDirectory(current, segment, createIfMissing, writable);
          handles.Add(current);
        }
        return handles;
      } catch {
        for (int i = handles.Count - 1; i >= 0; i--) {
          IntPtr handle = handles[i];
          CloseHandle(ref handle);
        }
        throw;
      }
    }

    private static void CloseDirectoryChain(List<IntPtr> handles) {
      for (int i = handles.Count - 1; i >= 0; i--) {
        IntPtr handle = handles[i];
        CloseHandle(ref handle);
      }
    }

    public static string ReadTextBase64(string rootPath, RootIdentity rootIdentity, string relativePath, int maxBytes) {
      if (maxBytes < 0 || maxBytes > MaxTextBytes) {
        throw new SecureFsException("SECURE_FS_INVALID_OPERATION");
      }
      string[] segments = RelativeSegments(relativePath);
      if (segments.Length == 0) throw new SecureFsException("SECURE_FS_INVALID_PATH");
      List<IntPtr> directories = OpenDirectoryChain(rootPath, rootIdentity, Prefix(segments), false, false);
      IntPtr file = IntPtr.Zero;
      try {
        file = OpenFile(
          directories[directories.Count - 1],
          segments[segments.Length - 1],
          FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_OPEN);
        SafeFileHandle safeHandle = new SafeFileHandle(file, true);
        file = IntPtr.Zero;
        using (safeHandle) {
          using (FileStream stream = new FileStream(safeHandle, FileAccess.Read, 4096, false)) {
            long initialLength = stream.Length;
            if (initialLength > maxBytes) throw new SecureFsException("SECURE_FS_FILE_TOO_LARGE");
            using (MemoryStream content = new MemoryStream((int)initialLength)) {
              byte[] buffer = new byte[8192];
              while (true) {
                int remaining = maxBytes - (int)content.Length;
                int count = stream.Read(buffer, 0, Math.Min(buffer.Length, remaining + 1));
                if (count == 0) break;
                if (count > remaining) throw new SecureFsException("SECURE_FS_FILE_TOO_LARGE");
                int requiredCapacity = (int)content.Length + count;
                if (requiredCapacity > content.Capacity) content.Capacity = requiredCapacity;
                content.Write(buffer, 0, count);
              }
              return Convert.ToBase64String(content.GetBuffer(), 0, (int)content.Length);
            }
          }
        }
      } finally {
        CloseHandle(ref file);
        CloseDirectoryChain(directories);
      }
    }

    private static string[] Prefix(string[] segments) {
      if (segments.Length <= 1) return new string[0];
      string[] prefix = new string[segments.Length - 1];
      Array.Copy(segments, prefix, prefix.Length);
      return prefix;
    }

    private static void RenameIntoDirectory(IntPtr fileHandle, IntPtr parentDirectory, string targetName) {
      byte[] name = System.Text.Encoding.Unicode.GetBytes(targetName);
      int lengthOffset = (int)Marshal.OffsetOf(typeof(RenameInformationHeader), "FileNameLength") + sizeof(uint);
      IntPtr buffer = Marshal.AllocHGlobal(lengthOffset + name.Length);
      try {
        RenameInformationHeader header = new RenameInformationHeader {
          ReplaceIfExists = 1,
          RootDirectory = parentDirectory,
          FileNameLength = checked((uint)name.Length),
        };
        Marshal.StructureToPtr(header, buffer, false);
        Marshal.Copy(name, 0, IntPtr.Add(buffer, lengthOffset), name.Length);
        IoStatusBlock ioStatus;
        int status = NtSetInformationFile(
          fileHandle,
          out ioStatus,
          buffer,
          checked((uint)(lengthOffset + name.Length)),
          FileRenameInformation);
        if (status == STATUS_ACCESS_DENIED && TargetIsOpenElsewhere(parentDirectory, targetName)) {
          throw new SecureFsException("SECURE_FS_TARGET_IN_USE");
        }
        if (status != STATUS_SUCCESS) ThrowForStatus(status);
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    // Replacing a target that another program holds open fails with ACCESS_DENIED,
    // which a read-only target also returns. Only an open target refuses an
    // exclusive open with SHARING_VIOLATION. A read-only target stays unwritable
    // after the other program closes it, so it keeps the generic failure.
    private static bool TargetIsOpenElsewhere(IntPtr parentDirectory, string targetName) {
      IntPtr probe;
      int status = CreateRelative(
        parentDirectory,
        targetName,
        FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_ATTRIBUTE_NORMAL,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        true,
        out probe);
      if (status != STATUS_SUCCESS) return false;
      ByHandleFileInformation information;
      bool readOnly = !GetFileInformationByHandle(probe, out information)
        || (information.FileAttributes & FILE_ATTRIBUTE_READONLY) != 0;
      CloseHandle(ref probe);
      if (readOnly) return false;
      status = CreateRelative(
        parentDirectory,
        targetName,
        FILE_READ_DATA | SYNCHRONIZE,
        FILE_ATTRIBUTE_NORMAL,
        FILE_OPEN,
        FILE_NON_DIRECTORY_FILE,
        0,
        true,
        out probe);
      if (status == STATUS_SUCCESS) CloseHandle(ref probe);
      return status == STATUS_SHARING_VIOLATION;
    }

    private static void MarkDeleteOnClose(IntPtr fileHandle) {
      DispositionInformation disposition = new DispositionInformation { DeleteFile = 1 };
      IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(DispositionInformation)));
      try {
        Marshal.StructureToPtr(disposition, buffer, false);
        IoStatusBlock ioStatus;
        NtSetInformationFile(
          fileHandle,
          out ioStatus,
          buffer,
          checked((uint)Marshal.SizeOf(typeof(DispositionInformation))),
          FileDispositionInformation);
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    private static void WriteAndFlush(IntPtr fileHandle, byte[] content) {
      IoStatusBlock ioStatus;
      int status = NtWriteFile(
        fileHandle,
        IntPtr.Zero,
        IntPtr.Zero,
        IntPtr.Zero,
        out ioStatus,
        content,
        checked((uint)content.Length),
        IntPtr.Zero,
        IntPtr.Zero);
      if (status != STATUS_SUCCESS || ioStatus.Information.ToInt64() != content.Length) {
        throw new SecureFsException("SECURE_FS_WRITE_FAILED");
      }
      status = NtFlushBuffersFile(fileHandle, out ioStatus);
      if (status != STATUS_SUCCESS) throw new SecureFsException("SECURE_FS_WRITE_FAILED");
    }

    /** Holds the temporary file and directory handles until main-process lease validation decides commit/cancel. */
    public sealed class AtomicWriteSession : IDisposable {
      private List<IntPtr> directories;
      private SafeFileHandle temporaryFile;
      private IntPtr parentDirectory;
      private string targetName;
      private bool committed;

      internal AtomicWriteSession(
        List<IntPtr> directories,
        SafeFileHandle temporaryFile,
        IntPtr parentDirectory,
        string targetName) {
        this.directories = directories;
        this.temporaryFile = temporaryFile;
        this.parentDirectory = parentDirectory;
        this.targetName = targetName;
      }

      public void Commit() {
        if (temporaryFile == null || temporaryFile.IsClosed || temporaryFile.IsInvalid) {
          throw new SecureFsException("SECURE_FS_WRITE_FAILED");
        }
        RenameIntoDirectory(temporaryFile.DangerousGetHandle(), parentDirectory, targetName);
        committed = true;
      }

      public void Dispose() {
        if (temporaryFile != null) {
          if (!committed && !temporaryFile.IsClosed && !temporaryFile.IsInvalid) {
            MarkDeleteOnClose(temporaryFile.DangerousGetHandle());
          }
          temporaryFile.Dispose();
          temporaryFile = null;
        }
        if (directories != null) {
          CloseDirectoryChain(directories);
          directories = null;
        }
        parentDirectory = IntPtr.Zero;
        targetName = null;
      }
    }

    public static AtomicWriteSession BeginAtomicWrite(string rootPath, RootIdentity rootIdentity, string relativePath, byte[] content) {
      if (content == null || content.Length > MaxTextBytes) throw new SecureFsException("SECURE_FS_FILE_TOO_LARGE");
      string[] segments = RelativeSegments(relativePath);
      if (segments.Length == 0) throw new SecureFsException("SECURE_FS_INVALID_PATH");
      List<IntPtr> directories = OpenDirectoryChain(rootPath, rootIdentity, Prefix(segments), false, true);
      IntPtr temporaryFile = IntPtr.Zero;
      try {
        IntPtr parent = directories[directories.Count - 1];
        string temporaryName = ".ai-novel-" + Guid.NewGuid().ToString("N") + ".tmp";
        temporaryFile = OpenFile(
          parent,
          temporaryName,
          FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | DELETE | SYNCHRONIZE,
          FILE_CREATE);
        WriteAndFlush(temporaryFile, content);
        SafeFileHandle safeHandle = new SafeFileHandle(temporaryFile, true);
        temporaryFile = IntPtr.Zero;
        AtomicWriteSession session = new AtomicWriteSession(
          directories,
          safeHandle,
          parent,
          segments[segments.Length - 1]);
        directories = null;
        return session;
      } finally {
        CloseHandle(ref temporaryFile);
        if (directories != null) CloseDirectoryChain(directories);
      }
    }

    public static void MakeDirectory(string rootPath, RootIdentity rootIdentity, string relativePath) {
      string[] segments = RelativeSegments(relativePath);
      List<IntPtr> directories = OpenDirectoryChain(rootPath, rootIdentity, segments, true, true);
      CloseDirectoryChain(directories);
    }

    public static bool Exists(string rootPath, RootIdentity rootIdentity, string relativePath) {
      string[] segments = RelativeSegments(relativePath);
      if (segments.Length == 0) {
        List<IntPtr> root = OpenDirectoryChain(rootPath, rootIdentity, segments, false, false);
        CloseDirectoryChain(root);
        return true;
      }
      List<IntPtr> directories;
      try {
        directories = OpenDirectoryChain(rootPath, rootIdentity, Prefix(segments), false, false);
      } catch (SecureFsException error) {
        if (error.Code == "SECURE_FS_NOT_FOUND") return false;
        throw;
      }
      IntPtr target = IntPtr.Zero;
      try {
        target = OpenRelative(
          directories[directories.Count - 1],
          segments[segments.Length - 1],
          FILE_READ_ATTRIBUTES | SYNCHRONIZE,
          FILE_ATTRIBUTE_NORMAL,
          FILE_OPEN,
          0);
        return true;
      } catch (SecureFsException error) {
        if (error.Code == "SECURE_FS_NOT_FOUND") return false;
        throw;
      } finally {
        CloseHandle(ref target);
        CloseDirectoryChain(directories);
      }
    }

    public static SecureDirectoryEntry[] ListDirectory(string rootPath, RootIdentity rootIdentity, string relativePath) {
      string[] segments = RelativeSegments(relativePath);
      List<IntPtr> directories = OpenDirectoryChain(rootPath, rootIdentity, segments, false, false);
      IntPtr buffer = IntPtr.Zero;
      try {
        IntPtr directory = directories[directories.Count - 1];
        buffer = Marshal.AllocHGlobal(65536);
        List<SecureDirectoryEntry> entries = new List<SecureDirectoryEntry>();
        bool restart = true;
        while (true) {
          IoStatusBlock ioStatus;
          int status = NtQueryDirectoryFile(
            directory,
            IntPtr.Zero,
            IntPtr.Zero,
            IntPtr.Zero,
            out ioStatus,
            buffer,
            65536,
            FileDirectoryInformation,
            false,
            IntPtr.Zero,
            restart);
          restart = false;
          if (status == STATUS_NO_MORE_FILES) break;
          if (status != STATUS_SUCCESS && status != STATUS_BUFFER_OVERFLOW) ThrowForStatus(status);
          int bytes = checked((int)ioStatus.Information.ToInt64());
          int offset = 0;
          while (offset < bytes) {
            int nextOffset = Marshal.ReadInt32(buffer, offset);
            uint attributes = unchecked((uint)Marshal.ReadInt32(buffer, offset + 56));
            int nameLength = Marshal.ReadInt32(buffer, offset + 60);
            if (nameLength < 0 || (nameLength % 2) != 0 || offset + 64 + nameLength > bytes) {
              throw new SecureFsException("SECURE_FS_HELPER_FAILED");
            }
            string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 64), nameLength / 2);
            if (name != "." && name != "..") {
              // A directory may legitimately contain system compatibility
              // junctions (for example C:\Documents and Settings). Omitting
              // them keeps recursive enumeration usable without making the
              // entry traversable: any explicit access still goes through
              // OBJ_DONT_REPARSE in OpenRelative and fails closed.
              if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0) {
                ValidateSegment(name);
                entries.Add(new SecureDirectoryEntry {
                  Name = name,
                  IsDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0,
                });
                if (entries.Count > MaxEntries) throw new SecureFsException("SECURE_FS_DIRECTORY_TOO_LARGE");
              }
            }
            if (nextOffset == 0) break;
            if (nextOffset < 0 || offset + nextOffset > bytes) throw new SecureFsException("SECURE_FS_HELPER_FAILED");
            offset += nextOffset;
          }
        }
        return entries.ToArray();
      } finally {
        if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
        CloseDirectoryChain(directories);
      }
    }
  }
}

namespace AiNovelSecureFs {
  using System.Collections;
  using System.Text;
  using System.Web.Script.Serialization;

  // 每个进程只处理一个请求，经 stdin/stdout 与 TypeScript 侧通信。
  // 字段名按大小写不敏感匹配，仅大小写不同的重复键会被拒绝（AsObject）。
  public static class Program {
    private const int MaxRequestCharacters = 100000000;
    private const int MaxCommandCharacters = 4096;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };

    private static Dictionary<string, object> ParseObject(string line) {
      return AsObject(Json.DeserializeObject(line));
    }

    private static Dictionary<string, object> AsObject(object value) {
      Dictionary<string, object> parsed = value as Dictionary<string, object>;
      if (parsed == null) return null;
      Dictionary<string, object> result = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
      foreach (KeyValuePair<string, object> entry in parsed) {
        if (entry.Key.Length == 0) throw new SecureFsException("SECURE_FS_HELPER_FAILED");
        result.Add(entry.Key, entry.Value);
      }
      return result;
    }

    private static object Field(Dictionary<string, object> source, string name) {
      object value;
      return source.TryGetValue(name, out value) ? value : null;
    }

    private static Dictionary<string, object> Ok() {
      return new Dictionary<string, object> { { "ok", true } };
    }

    private static void Respond(TextWriter output, Dictionary<string, object> response) {
      output.WriteLine(Json.Serialize(response));
      output.Flush();
    }

    private static void Handle(TextReader input, TextWriter output) {
      string inputLine = input.ReadLine();
      if (inputLine == null || inputLine.Length > MaxRequestCharacters) {
        throw new SecureFsException("SECURE_FS_REQUEST_TOO_LARGE");
      }
      Dictionary<string, object> request = ParseObject(inputLine);
      if (request == null || !request.ContainsKey("operation") || !request.ContainsKey("rootPath")
          || !request.ContainsKey("relativePath") || !request.ContainsKey("rootIdentity")) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
      string rootPath = Field(request, "rootPath") as string;
      string relativePath = Field(request, "relativePath") as string;
      if (rootPath == null || relativePath == null) throw new SecureFsException("SECURE_FS_INVALID_PATH");
      Dictionary<string, object> identity = AsObject(Field(request, "rootIdentity"));
      if (identity == null || !(Field(identity, "volumeSerialNumber") is string) || !(Field(identity, "fileIndex") is string)) {
        throw new SecureFsException("SECURE_FS_INVALID_PATH");
      }
      SecureHandleFileSystem.RootIdentity rootIdentity = SecureHandleFileSystem.ParseRootIdentity(
        (string)Field(identity, "volumeSerialNumber"),
        (string)Field(identity, "fileIndex"));

      switch (Field(request, "operation") as string) {
        case "read": {
          object maxBytes = Field(request, "maxBytes");
          if (!(maxBytes is int) || (int)maxBytes < 0 || (int)maxBytes > 67108864) {
            throw new SecureFsException("SECURE_FS_INVALID_OPERATION");
          }
          Dictionary<string, object> response = Ok();
          response["contentBase64"] = SecureHandleFileSystem.ReadTextBase64(rootPath, rootIdentity, relativePath, (int)maxBytes);
          Respond(output, response);
          return;
        }
        case "write": {
          string contentBase64 = Field(request, "contentBase64") as string;
          if (contentBase64 == null) throw new SecureFsException("SECURE_FS_INVALID_TEXT");
          byte[] content = Convert.FromBase64String(contentBase64);
          using (SecureHandleFileSystem.AtomicWriteSession session = SecureHandleFileSystem.BeginAtomicWrite(rootPath, rootIdentity, relativePath, content)) {
            Dictionary<string, object> ready = Ok();
            ready["phase"] = "ready";
            Respond(output, ready);
            string commandLine = input.ReadLine();
            if (commandLine == null || commandLine.Length > MaxCommandCharacters) {
              throw new SecureFsException("SECURE_FS_CANCELLED");
            }
            Dictionary<string, object> command = ParseObject(commandLine);
            if (command == null || !"commit".Equals(Field(command, "command"))) {
              Dictionary<string, object> cancelled = new Dictionary<string, object> { { "ok", false }, { "code", "SECURE_FS_CANCELLED" } };
              Respond(output, cancelled);
              return;
            }
            session.Commit();
            Respond(output, Ok());
          }
          return;
        }
        case "mkdir":
          SecureHandleFileSystem.MakeDirectory(rootPath, rootIdentity, relativePath);
          Respond(output, Ok());
          return;
        case "exists": {
          Dictionary<string, object> response = Ok();
          response["exists"] = SecureHandleFileSystem.Exists(rootPath, rootIdentity, relativePath);
          Respond(output, response);
          return;
        }
        case "list": {
          ArrayList entries = new ArrayList();
          foreach (SecureDirectoryEntry entry in SecureHandleFileSystem.ListDirectory(rootPath, rootIdentity, relativePath)) {
            entries.Add(new Dictionary<string, object> { { "name", entry.Name }, { "isDirectory", entry.IsDirectory } });
          }
          Dictionary<string, object> response = Ok();
          response["entries"] = entries;
          Respond(output, response);
          return;
        }
        default:
          throw new SecureFsException("SECURE_FS_INVALID_OPERATION");
      }
    }

    public static int Main() {
      UTF8Encoding utf8 = new UTF8Encoding(false);
      TextReader input = new StreamReader(Console.OpenStandardInput(), utf8, false, 65536);
      TextWriter output = new StreamWriter(Console.OpenStandardOutput(), utf8, 65536);
      try {
        Handle(input, output);
      } catch (Exception error) {
        SecureFsException secure = error as SecureFsException;
        string code = secure != null ? secure.Code : "SECURE_FS_HELPER_FAILED";
        try {
          Respond(output, new Dictionary<string, object> { { "ok", false }, { "code", code } });
        } catch (Exception) {
          // The parent already closed stdout; it reports a missing response on its own.
        }
      }
      return 0;
    }
  }
}
